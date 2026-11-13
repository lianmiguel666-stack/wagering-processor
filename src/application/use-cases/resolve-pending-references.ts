import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { DomainError } from "../../domain/shared/domain-error";
import { ConcurrencyConflictError, TransientInfrastructureError, UniqueViolationError } from "../errors";
import { UnitOfWork } from "../ports/repositories";
import { AppLogger, Clock, Metrics } from "../ports/runtime";
import { WagerProcessor } from "../services/wager-processor";

export interface ResolvePendingReferencesOptions {
  batchSize: number;
  /** How long a claimed row is hidden from other workers. */
  leaseMs: number;
}

export interface ResolveRunSummary {
  claimed: number;
  settled: number;
  stillPending: number;
  skipped: number;
  failed: number;
}

/**
 * Scheduled worker body: retries PENDING_REFERENCE transactions whose
 * next_retry_at is due. Safe with N concurrent workers:
 *  - claim = short transaction with FOR UPDATE SKIP LOCKED that pushes
 *    next_retry_at forward (a lease); no row lock is held afterwards;
 *  - each row is then settled in its own transaction that locks the WALLET
 *    first (same lock order as the main path → no deadlocks) and re-reads
 *    the transaction; if someone else already settled it, it is skipped.
 */
export class ResolvePendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly options: ResolvePendingReferencesOptions = { batchSize: 50, leaseMs: 30_000 },
  ) {}

  async runOnce(): Promise<ResolveRunSummary> {
    const summary: ResolveRunSummary = { claimed: 0, settled: 0, stillPending: 0, skipped: 0, failed: 0 };
    const claimed = await this.uow.transactional((repos) =>
      repos.transactions.claimDuePendingReferences(this.clock.now(), this.options.batchSize, this.options.leaseMs),
    );
    summary.claimed = claimed.length;

    for (const { id, walletId } of claimed) {
      try {
        const status = await this.uow.transactional(async (repos) => {
          const wallet = await repos.wallets.findByIdForUpdate(walletId);
          const tx = await repos.transactions.findById(id);
          if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) {
            return "skipped" as const;
          }
          await this.processor.settle(repos, tx, wallet, false, {
            correlationId: tx.correlationId ?? tx.id,
            causationId: tx.id,
          });
          return tx.status;
        });
        if (status === "skipped") summary.skipped++;
        else if (status === WagerTransactionStatus.PendingReference) summary.stillPending++;
        else {
          summary.settled++;
          this.metrics.transactionCompleted(status, "pending_reference", "worker");
        }
      } catch (error) {
        if (
          error instanceof TransientInfrastructureError ||
          error instanceof ConcurrencyConflictError ||
          error instanceof UniqueViolationError
        ) {
          // Lease expires and the row is picked up again later.
          this.metrics.retry("pending_reference_transient");
          this.logger.warn("pending reference retry postponed", { transactionId: id, walletId, reason: String(error) });
          continue;
        }
        if (error instanceof DomainError) throw error; // programming error: surface loudly
        summary.failed++;
        await this.markFailed(id, error);
      }
    }
    return summary;
  }

  /** Permanent, unexpected error: park the transaction as FAILED so it is auditable and stops retrying. */
  private async markFailed(id: string, error: unknown): Promise<void> {
    this.logger.error("pending reference processing failed permanently", { transactionId: id, err: String(error) });
    try {
      await this.uow.transactional(async (repos) => {
        const tx = await repos.transactions.findById(id);
        if (!tx || tx.isTerminal()) return;
        const expected = { status: tx.status, referenceAttempts: tx.referenceAttempts };
        tx.fail(FailureCode.ProcessingFailed, this.clock.now());
        await repos.transactions.update(tx, expected);
      });
    } catch (secondary) {
      this.logger.error("could not mark transaction as FAILED", { transactionId: id, err: String(secondary) });
    }
  }
}
