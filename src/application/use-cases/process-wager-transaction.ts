import { InboxMessage } from "../../domain/messaging/inbox-message";
import { MoneyProps } from "../../domain/money/money";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction, WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import {
  ConcurrencyConflictError,
  DuplicateExternalTransactionIdError,
  IdempotencyConflictError,
  UniqueViolationError,
  WalletNotFoundError,
} from "../errors";
import { TransactionalRepositories, UnitOfWork } from "../ports/repositories";
import { AppLogger, Clock, IdGenerator, Metrics, ProcessingSource } from "../ports/runtime";
import { WagerProcessor } from "../services/wager-processor";
import { SubmitWagerCommand } from "./wager-command";

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Wallet balance observed when the transaction reached its current state. */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface InboxContext {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface ExecutionContext {
  source: ProcessingSource;
  correlationId: string;
  causationId?: string;
  /** Present when the command came from a queue: enables inbox de-duplication. */
  inbox?: InboxContext;
}

export type ProcessOutcome =
  | { type: "result"; result: WagerResult }
  /** The queue message was already consumed (inbox hit). Ack and move on. */
  | { type: "duplicate-message" };

/** Bounded internal retries for races detected by the database. */
const MAX_ATTEMPTS = 3;

/**
 * Single entry point for provider transactions, reused by HTTP and SQS.
 *
 * Inside ONE SQL transaction:
 *   1. inbox claim (queue only)            — dedup by (consumer, messageId)
 *   2. SELECT wallet … FOR UPDATE          — serialises everything per wallet
 *   3. idempotency lookup                  — replay or conflict
 *   4. settle (domain) + persist tx, balance CAS, ledger, outbox
 *   5. inbox mark processed
 *
 * Unique-constraint races (two requests with the same key on different
 * wallets, for instance) roll back and are retried; the retry then takes the
 * replay/conflict path. The database constraints, not this code, are the
 * final guarantee.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly processor: WagerProcessor,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(command: SubmitWagerCommand, context: ExecutionContext): Promise<ProcessOutcome> {
    const started = performance.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const outcome = await this.uow.transactional((repos) => this.run(repos, command, context));
        this.record(outcome, command, context, started);
        return outcome;
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          this.metrics.duplicateDetected("idempotency_conflict");
        }
        const retryable = error instanceof UniqueViolationError || error instanceof ConcurrencyConflictError;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
        this.metrics.retry(error instanceof UniqueViolationError ? "unique_violation" : "concurrency_conflict");
        this.logger.warn("retrying wager transaction after database race", {
          attempt,
          reason: error.message,
          walletId: command.walletId,
          providerId: command.providerId,
        });
      }
    }
  }

  private async run(
    repos: TransactionalRepositories,
    command: SubmitWagerCommand,
    context: ExecutionContext,
  ): Promise<ProcessOutcome> {
    let inboxMessage: InboxMessage | undefined;
    if (context.inbox) {
      inboxMessage = InboxMessage.receive({ ...context.inbox, receivedAt: this.clock.now() });
      const claimed = await repos.inbox.tryReceive(inboxMessage);
      if (!claimed) {
        const existing = await repos.inbox.find(context.inbox.consumerName, context.inbox.messageId);
        if (existing && existing.payloadHash !== context.inbox.payloadHash) {
          this.logger.warn("inbox hit with different payload hash for the same messageId", {
            messageId: context.inbox.messageId,
          });
        }
        return { type: "duplicate-message" };
      }
    }

    // Lock first: every subsequent read sees the latest committed state of
    // this wallet, and concurrent commands for it queue up here.
    const wallet = await repos.wallets.findByIdForUpdate(command.walletId);

    const existing = await repos.transactions.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(command.payloadHash)) {
        throw new IdempotencyConflictError(command.idempotencyKey, existing.id);
      }
      if (inboxMessage) await this.markInbox(repos, inboxMessage);
      return { type: "result", result: toResult(existing, true) };
    }

    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const sameExternal = await repos.transactions.findByProviderAndExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (sameExternal) {
      throw new DuplicateExternalTransactionIdError(command.providerId, command.externalTransactionId);
    }

    const tx = WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: command.payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      correlationId: context.correlationId,
      createdAt: this.clock.now(),
    });

    await this.processor.settle(repos, tx, wallet, true, {
      correlationId: context.correlationId,
      causationId: context.causationId,
    });

    if (inboxMessage) await this.markInbox(repos, inboxMessage);
    return { type: "result", result: toResult(tx, false) };
  }

  private async markInbox(repos: TransactionalRepositories, message: InboxMessage): Promise<void> {
    message.markProcessed(this.clock.now());
    await repos.inbox.markProcessed(message);
  }

  private record(outcome: ProcessOutcome, command: SubmitWagerCommand, context: ExecutionContext, started: number) {
    this.metrics.processingDuration((performance.now() - started) / 1000, context.source);
    if (outcome.type === "duplicate-message") {
      this.metrics.duplicateDetected("inbox");
      this.logger.info("duplicate message ignored (inbox)", { messageId: context.inbox?.messageId });
      return;
    }
    const { result } = outcome;
    if (result.idempotentReplay) {
      this.metrics.duplicateDetected("idempotency_replay");
    } else {
      this.metrics.transactionCompleted(result.status, command.kind, context.source);
    }
    this.logger.info("wager transaction handled", {
      transactionId: result.transactionId,
      walletId: command.walletId,
      providerId: command.providerId,
      kind: command.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
    });
  }
}

export function toResult(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  const result: WagerResult = {
    transactionId: tx.id,
    status: tx.status,
    idempotentReplay,
  };
  if (tx.resultBalance) result.balance = tx.resultBalance.toJSON();
  if (tx.failureCode) result.failureCode = tx.failureCode;
  return result;
}
