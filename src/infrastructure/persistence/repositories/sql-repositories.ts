import { ConcurrencyConflictError, UniqueViolationError, WalletAlreadyExistsError } from "../../../application/errors";
import { InboxRepository, LedgerPage, LedgerRepository, OutboxRepository, OutboxStats, ReconciliationSnapshot, WagerTransactionRepository, WalletRepository } from "../../../application/ports/repositories";
import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { WagerTransaction, WagerTransactionStatus } from "../../../domain/wagering/wager-transaction";
import { Wallet } from "../../../domain/wallet/wallet";
import { WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import type { SqlExecutor } from "../sql/sql-executor";
import { inboxFromRow, ledgerEntryFromRow, moneyFromDb, outboxFromRow, transactionFromRow, walletFromRow } from "./mappers";

/*
 * Repositories write explicit SQL on purpose: every statement on the money
 * path (locks, compare-and-set updates, SKIP LOCKED claims) is visible and
 * reviewable here, and the schema constraints are the final arbiter.
 */

const WALLET_COLUMNS = "id, player_id, currency, balance, version, created_at, updated_at";

export class SqlWalletRepository implements WalletRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(id: string): Promise<Wallet | null> {
    const rows = await this.sql.query(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ?`, [id]);
    return rows[0] ? walletFromRow(rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    // Row-level lock on ONE wallet; unrelated wallets proceed in parallel.
    const rows = await this.sql.query(`SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = ? FOR UPDATE`, [id]);
    return rows[0] ? walletFromRow(rows[0]) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    try {
      await this.sql.query(
        `INSERT INTO wallets (${WALLET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toString(),
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === "uq_wallets_player_currency") {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }
  }

  async updateBalance(wallet: Wallet, expectedVersion: number): Promise<void> {
    const rows = await this.sql.query(
      `UPDATE wallets SET balance = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?
        RETURNING id`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
    );
    if (rows.length !== 1) throw new ConcurrencyConflictError("wallet", wallet.id);
  }
}

const TX_COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status,
  failure_code, result_balance, reference_attempts, next_retry_at, correlation_id, created_at, processed_at, updated_at`;

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const rows = await this.sql.query(`SELECT ${TX_COLUMNS} FROM wager_transactions WHERE id = ?`, [id]);
    return rows[0] ? transactionFromRow(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const rows = await this.sql.query(`SELECT ${TX_COLUMNS} FROM wager_transactions WHERE idempotency_key = ?`, [key]);
    return rows[0] ? transactionFromRow(rows[0]) : null;
  }

  async findByProviderAndExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const rows = await this.sql.query(
      `SELECT ${TX_COLUMNS} FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalTransactionId],
    );
    return rows[0] ? transactionFromRow(rows[0]) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.sql.query(
      `SELECT 1 AS found FROM wager_transactions
        WHERE reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'
        LIMIT 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async findPendingByReference(
    providerId: string,
    referenceExternalTransactionId: string,
    walletId: string,
  ): Promise<WagerTransaction[]> {
    const rows = await this.sql.query(
      `SELECT ${TX_COLUMNS} FROM wager_transactions
        WHERE provider_id = ? AND reference_external_transaction_id = ? AND wallet_id = ?
          AND status = 'PENDING_REFERENCE'
        ORDER BY created_at, id
        FOR UPDATE`,
      [providerId, referenceExternalTransactionId, walletId],
    );
    return rows.map(transactionFromRow);
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.sql.query(
      `INSERT INTO wager_transactions (${TX_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.money.currency,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.status,
        tx.failureCode ?? null,
        tx.resultBalance?.toString() ?? null,
        tx.referenceAttempts,
        tx.nextRetryAt ?? null,
        tx.correlationId ?? null,
        tx.createdAt,
        tx.processedAt ?? null,
        tx.updatedAt,
      ],
    );
  }

  async update(
    tx: WagerTransaction,
    expected: { status: WagerTransactionStatus; referenceAttempts: number },
  ): Promise<void> {
    const rows = await this.sql.query(
      `UPDATE wager_transactions
          SET status = ?, failure_code = ?, reference_transaction_id = ?, result_balance = ?,
              reference_attempts = ?, next_retry_at = ?, processed_at = ?, updated_at = ?
        WHERE id = ? AND status = ? AND reference_attempts = ?
        RETURNING id`,
      [
        tx.status,
        tx.failureCode ?? null,
        tx.referenceTransactionId ?? null,
        tx.resultBalance?.toString() ?? null,
        tx.referenceAttempts,
        tx.nextRetryAt ?? null,
        tx.processedAt ?? null,
        tx.updatedAt,
        tx.id,
        expected.status,
        expected.referenceAttempts,
      ],
    );
    if (rows.length !== 1) throw new ConcurrencyConflictError("wager_transaction", tx.id);
  }

  async claimDuePendingReferences(
    now: Date,
    limit: number,
    leaseMs: number,
  ): Promise<Array<{ id: string; walletId: string }>> {
    const rows = await this.sql.query<{ id: string; wallet_id: string }>(
      `UPDATE wager_transactions t
          SET next_retry_at = ?
        WHERE t.id IN (
          SELECT id FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_retry_at <= ?
           ORDER BY next_retry_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING t.id, t.wallet_id`,
      [new Date(now.getTime() + leaseMs), now, limit],
    );
    return rows.map((r) => ({ id: String(r.id), walletId: String(r.wallet_id) }));
  }
}

const LEDGER_COLUMNS = `id, sequence, wallet_id, transaction_id, direction, amount, currency, balance_before,
  balance_after, wallet_version, created_at`;

export class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.sql.query(
      `INSERT INTO wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.walletVersion,
        entry.createdAt,
      ],
    );
  }

  async listByWallet(walletId: string, afterSequence: string | undefined, limit: number): Promise<LedgerPage> {
    const rows = await this.sql.query(
      `SELECT ${LEDGER_COLUMNS} FROM wallet_ledger_entries
        WHERE wallet_id = ? AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
      [walletId, afterSequence ?? "0", limit + 1],
    );
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit).map(ledgerEntryFromRow);
    const last = entries[entries.length - 1];
    return { entries, nextSequence: hasMore && last ? last.sequence : undefined };
  }

  async reconcile(walletId: string): Promise<ReconciliationSnapshot | null> {
    // One statement ⇒ one snapshot: stored and derived balances are comparable.
    const rows = await this.sql.query(
      `SELECT w.balance, w.currency, w.version,
              COALESCE(SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)
                AS calculated,
              COUNT(e.id)::int AS entries,
              (SELECT balance_after FROM wallet_ledger_entries x
                WHERE x.wallet_id = w.id ORDER BY x.wallet_version DESC LIMIT 1) AS last_balance_after,
              MAX(e.wallet_version) AS last_wallet_version
         FROM wallets w
         LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
        WHERE w.id = ?
        GROUP BY w.id`,
      [walletId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      storedBalance: moneyFromDb(row.balance, row.currency),
      calculatedBalance: moneyFromDb(row.calculated, row.currency),
      lastBalanceAfter:
        row.last_balance_after === null || row.last_balance_after === undefined
          ? undefined
          : moneyFromDb(row.last_balance_after, row.currency),
      lastWalletVersion:
        row.last_wallet_version === null || row.last_wallet_version === undefined
          ? undefined
          : Number(row.last_wallet_version),
      walletVersion: Number(row.version),
      checkedEntries: Number(row.entries),
    };
  }
}

export class SqlInboxRepository implements InboxRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.sql.query(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const rows = await this.sql.query(
      `SELECT consumer_name, message_id, payload_hash, received_at, processed_at
         FROM inbox_messages WHERE consumer_name = ? AND message_id = ?`,
      [consumerName, messageId],
    );
    return rows[0] ? inboxFromRow(rows[0]) : null;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.sql.query(
      `UPDATE inbox_messages SET processed_at = ? WHERE consumer_name = ? AND message_id = ?`,
      [message.processedAt ?? new Date(), message.consumerName, message.messageId],
    );
  }
}

const OUTBOX_COLUMNS = `id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at,
  last_error`;

export class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async enqueue(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const values: string[] = [];
    const params: unknown[] = [];
    for (const m of messages) {
      values.push("(?, ?, ?, CAST(? AS jsonb), ?, ?, ?)");
      params.push(m.id, m.aggregateId, m.eventType, JSON.stringify(m.payload), m.occurredAt, m.attempts, m.nextAttemptAt ?? m.occurredAt);
    }
    await this.sql.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       VALUES ${values.join(", ")}`,
      params,
    );
  }

  async claimDue(now: Date, limit: number, leaseMs: number, owner: string): Promise<OutboxMessage[]> {
    const rows = await this.sql.query(
      `UPDATE outbox_messages o
          SET locked_by = ?, locked_until = ?
        WHERE o.id IN (
          SELECT id FROM outbox_messages
           WHERE published_at IS NULL
             AND next_attempt_at <= ?
             AND (locked_until IS NULL OR locked_until < ?)
           ORDER BY next_attempt_at, occurred_at
           LIMIT ?
           FOR UPDATE SKIP LOCKED)
        RETURNING ${OUTBOX_COLUMNS}`,
      [owner, new Date(now.getTime() + leaseMs), now, now, limit],
    );
    return rows.map(outboxFromRow).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }

  async saveAttempt(message: OutboxMessage, owner: string): Promise<boolean> {
    const rows = await this.sql.query(
      `UPDATE outbox_messages
          SET attempts = ?, next_attempt_at = ?, published_at = ?, last_error = ?,
              locked_by = NULL, locked_until = NULL
        WHERE id = ? AND locked_by = ? AND published_at IS NULL
        RETURNING id`,
      [
        message.attempts,
        message.nextAttemptAt ?? null,
        message.publishedAt ?? null,
        message.lastError ?? null,
        message.id,
        owner,
      ],
    );
    return rows.length === 1;
  }

  async stats(now: Date): Promise<OutboxStats> {
    const rows = await this.sql.query<{ pending: unknown; oldest: unknown }>(
      `SELECT COUNT(*)::int AS pending, MIN(occurred_at) AS oldest
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    const row = rows[0];
    const pending = Number(row?.pending ?? 0);
    const oldest = row?.oldest ? new Date(row.oldest as string) : undefined;
    return {
      pending,
      oldestPendingAgeSeconds: oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0,
    };
  }
}
