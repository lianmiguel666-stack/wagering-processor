import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { Money } from "../../../domain/money/money";
import { FailureCode, isFailureCode } from "../../../domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { Wallet } from "../../../domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../../domain/wallet/wallet-ledger-entry";
import { Row } from "../sql/sql-executor";

/**
 * numeric(20,2) → Money. Drivers return numeric as a string ("25.00"), so the
 * value never passes through a JS number. Signed values are accepted here
 * because reconciliation sums can (in a corrupted database) be negative.
 */
export function moneyFromDb(amount: unknown, currency: unknown): Money {
  const raw = String(amount).trim();
  const ccy = String(currency).trim();
  if (raw.startsWith("-")) return Money.from({ amount: raw.slice(1), currency: ccy }).negate();
  return Money.from({ amount: raw, currency: ccy });
}

export function optionalDate(value: unknown): Date | undefined {
  return value === null || value === undefined ? undefined : new Date(value as string | Date);
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

export function walletFromRow(row: Row): Wallet {
  return Wallet.rehydrate({
    id: String(row.id),
    playerId: String(row.player_id),
    currency: String(row.currency),
    balance: moneyFromDb(row.balance, row.currency),
    version: Number(row.version),
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  });
}

export function transactionFromRow(row: Row): WagerTransaction {
  const failure = optionalString(row.failure_code);
  return WagerTransaction.rehydrate({
    id: String(row.id),
    providerId: String(row.provider_id),
    externalTransactionId: String(row.external_transaction_id),
    idempotencyKey: String(row.idempotency_key),
    payloadHash: String(row.payload_hash),
    walletId: String(row.wallet_id),
    playerId: String(row.player_id),
    roundId: String(row.round_id),
    gameId: String(row.game_id),
    kind: String(row.kind) as WagerTransactionKind,
    money: moneyFromDb(row.amount, row.currency),
    referenceExternalTransactionId: optionalString(row.reference_external_transaction_id),
    correlationId: optionalString(row.correlation_id),
    createdAt: new Date(row.created_at as string),
    status: String(row.status) as WagerTransactionStatus,
    referenceTransactionId: optionalString(row.reference_transaction_id),
    failureCode: failure && isFailureCode(failure) ? (failure as FailureCode) : undefined,
    processedAt: optionalDate(row.processed_at),
    resultBalance:
      row.result_balance === null || row.result_balance === undefined
        ? undefined
        : moneyFromDb(row.result_balance, row.currency),
    referenceAttempts: Number(row.reference_attempts),
    nextRetryAt: optionalDate(row.next_retry_at),
    updatedAt: new Date(row.updated_at as string),
  });
}

export function ledgerEntryFromRow(row: Row): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: String(row.id),
    sequence: String(row.sequence),
    walletId: String(row.wallet_id),
    transactionId: String(row.transaction_id),
    direction: String(row.direction) as LedgerDirection,
    money: moneyFromDb(row.amount, row.currency),
    balanceBefore: moneyFromDb(row.balance_before, row.currency),
    balanceAfter: moneyFromDb(row.balance_after, row.currency),
    walletVersion: Number(row.wallet_version),
    createdAt: new Date(row.created_at as string),
  });
}

export function inboxFromRow(row: Row): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: String(row.consumer_name),
    messageId: String(row.message_id),
    payloadHash: String(row.payload_hash),
    receivedAt: new Date(row.received_at as string),
    processedAt: optionalDate(row.processed_at),
  });
}

export function outboxFromRow(row: Row): OutboxMessage {
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return OutboxMessage.rehydrate({
    id: String(row.id),
    aggregateId: String(row.aggregate_id),
    eventType: String(row.event_type),
    payload: payload as Record<string, unknown>,
    occurredAt: new Date(row.occurred_at as string),
    attempts: Number(row.attempts),
    nextAttemptAt: optionalDate(row.next_attempt_at),
    publishedAt: optionalDate(row.published_at),
    lastError: optionalString(row.last_error),
  });
}
