import { EventContext, IntegrationEvent } from "../../domain/events/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/wagering-events";
import { OutboxMessage, exponentialBackoffMs } from "../../domain/messaging/outbox-message";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerSettlement } from "../../domain/wagering/wager-settlement";
import { WagerTransaction, WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { TransactionalRepositories } from "../ports/repositories";
import { Clock, IdGenerator } from "../ports/runtime";

export interface PendingReferencePolicy {
  /** Total resolution attempts (the first one happens on arrival). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Defaults: 10 attempts, 1s → 2s → 4s … capped at 60s ⇒ ~4 minutes of
 * waiting. Out-of-order delivery between a BET and its REFUND/ROLLBACK is
 * normally milliseconds to seconds (parallel consumers, broker redelivery);
 * a reference still missing after minutes is a provider-side problem, and a
 * REFERENCE_NOT_FOUND rejection tells the provider to resend in order.
 * Note that arrival of the referenced transaction resolves dependents
 * immediately (see resolveDependents), so the backoff is only a fallback.
 */
export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  maxAttempts: 10,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
};

export interface ProcessingContext {
  correlationId: string;
  causationId?: string;
}

const MAX_DEPENDENT_DEPTH = 5;

/**
 * Applies a transaction to a wallet that the caller has ALREADY LOCKED in the
 * current SQL transaction, and persists every consequence atomically:
 * transaction row, wallet balance (CAS on version), ledger entry and outbox
 * events. Shared by the HTTP/SQS use case and the pending-reference worker.
 */
export class WagerProcessor {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
  ) {}

  async settle(
    repos: TransactionalRepositories,
    tx: WagerTransaction,
    lockedWallet: Wallet,
    isNew: boolean,
    context: ProcessingContext,
    depth = 0,
  ): Promise<WagerTransaction> {
    const now = this.clock.now();
    const expected = { status: tx.status, referenceAttempts: tx.referenceAttempts };
    const expectedVersion = lockedWallet.version;

    const reference = tx.referenceExternalTransactionId
      ? await repos.transactions.findByProviderAndExternalId(tx.providerId, tx.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference && tx.isReversal() ? await repos.transactions.hasProcessedReversal(reference.id) : false;

    const outcome = WagerSettlement.settle({
      transaction: tx,
      wallet: lockedWallet,
      reference,
      referenceAlreadyReversed,
      ledgerEntryId: this.ids.next(),
      at: now,
    });

    const events: IntegrationEvent<unknown>[] = [];
    const eventCtx: EventContext = {
      newId: () => this.ids.next(),
      correlationId: context.correlationId,
      causationId: context.causationId,
      occurredAt: now,
    };

    if (outcome.type === "awaiting-reference") {
      if (tx.referenceAttempts >= this.policy.maxAttempts) {
        tx.reject(FailureCode.ReferenceNotFound, now, lockedWallet.balance);
        events.push(WagerTransactionRejected.from(tx, eventCtx));
      } else {
        const wasPending = tx.status === WagerTransactionStatus.PendingReference;
        const delay = exponentialBackoffMs(tx.referenceAttempts + 1, this.policy);
        tx.markPendingReference(new Date(now.getTime() + delay), now, lockedWallet.balance);
        // Announce only the transition into PENDING_REFERENCE, not every retry.
        if (!wasPending) events.push(WagerTransactionPendingReference.from(tx, eventCtx));
      }
    } else if (outcome.type === "rejected") {
      events.push(WagerTransactionRejected.from(tx, eventCtx));
    } else {
      events.push(WagerTransactionProcessed.from(tx, lockedWallet, eventCtx));
      if (outcome.ledgerEntry) {
        events.push(WalletBalanceChanged.from(lockedWallet, outcome.ledgerEntry, eventCtx));
      }
    }

    // Persist. Order matters only for FKs: transaction row before ledger row.
    if (isNew) {
      await repos.transactions.insert(tx);
    } else {
      await repos.transactions.update(tx, expected);
    }
    if (outcome.type === "processed" && outcome.ledgerEntry) {
      await repos.wallets.updateBalance(lockedWallet, expectedVersion);
      await repos.ledger.append(outcome.ledgerEntry);
    }
    await repos.outbox.enqueue(events.map((event) => OutboxMessage.enqueue(event)));

    if (tx.isTerminal()) {
      await this.resolveDependents(repos, tx, lockedWallet, context, depth + 1);
    }
    return tx;
  }

  /**
   * When a transaction reaches a terminal state, transactions of the same
   * wallet that were parked waiting for it are settled right away, under the
   * wallet lock we already hold. Dependents of other wallets are left to the
   * worker (their wallet is not locked here, and they will be rejected as
   * REFERENCE_MISMATCH anyway).
   */
  private async resolveDependents(
    repos: TransactionalRepositories,
    resolved: WagerTransaction,
    lockedWallet: Wallet,
    context: ProcessingContext,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_DEPENDENT_DEPTH) return;
    const dependents = await repos.transactions.findPendingByReference(
      resolved.providerId,
      resolved.externalTransactionId,
      lockedWallet.id,
    );
    for (const dependent of dependents) {
      await this.settle(repos, dependent, lockedWallet, false, {
        correlationId: dependent.correlationId ?? context.correlationId,
        causationId: resolved.id,
      }, depth);
    }
  }
}
