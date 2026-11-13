import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money } from "../../domain/money/money";
import { WagerTransaction, WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** Loads the wallet holding a row-level write lock until the transaction ends. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** @throws WalletAlreadyExistsError */
  insert(wallet: Wallet): Promise<void>;
  /**
   * Compare-and-set on `version`.
   * @throws ConcurrencyConflictError if the stored version is not `expectedVersion`.
   */
  updateBalance(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** True if `referenceTransactionId` already has a PROCESSED REFUND or ROLLBACK. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** PENDING_REFERENCE transactions of `walletId` waiting for (providerId, externalTransactionId). */
  findPendingByReference(
    providerId: string,
    referenceExternalTransactionId: string,
    walletId: string,
  ): Promise<WagerTransaction[]>;
  /** @throws UniqueViolationError */
  insert(tx: WagerTransaction): Promise<void>;
  /**
   * Compare-and-set on `status` (+ attempts for pending-reference bookkeeping).
   * @throws ConcurrencyConflictError
   */
  update(tx: WagerTransaction, expected: { status: WagerTransactionStatus; referenceAttempts: number }): Promise<void>;
  /**
   * Leases due PENDING_REFERENCE rows (pushes next_retry_at forward by
   * `leaseMs`, using SKIP LOCKED) and returns their ids. Runs in its own short
   * transaction so it never holds row locks while wallets are being locked.
   */
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<Array<{ id: string; walletId: string }>>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  nextSequence?: string;
}

export interface ReconciliationSnapshot {
  storedBalance: Money;
  calculatedBalance: Money;
  /** balance_after of the most recent entry (chain head). */
  lastBalanceAfter?: Money;
  lastWalletVersion?: number;
  walletVersion: number;
  checkedEntries: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  listByWallet(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage>;
  /** Stored balance and ledger-derived balance read from one snapshot. */
  reconcile(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export interface InboxRepository {
  /**
   * Inserts the inbox row; returns false when (consumerName, messageId)
   * already exists. Concurrent receivers of the same message block on the
   * primary key until the first one commits or rolls back.
   */
  tryReceive(message: InboxMessage): Promise<boolean>;
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxStats {
  pending: number;
  oldestPendingAgeSeconds: number;
}

export interface OutboxRepository {
  enqueue(messages: readonly OutboxMessage[]): Promise<void>;
  /** Leases due messages to `owner` for `leaseMs` (FOR UPDATE SKIP LOCKED). */
  claimDue(now: Date, limit: number, leaseMs: number, owner: string): Promise<OutboxMessage[]>;
  /** Persists publish/retry bookkeeping only if `owner` still holds the lease. Returns false otherwise. */
  saveAttempt(message: OutboxMessage, owner: string): Promise<boolean>;
  stats(now: Date): Promise<OutboxStats>;
}

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Unit of Work port: `work` runs inside one SQL transaction. Every repository
 * handed to it shares that transaction; returning commits, throwing rolls back.
 */
export interface UnitOfWork {
  transactional<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T>;
}
