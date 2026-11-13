import { MoneyProps } from "../money/money";
import { FailureCode } from "../wagering/failure-code";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "../wagering/wager-transaction";
import { Wallet } from "../wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { EventContext, IntegrationEvent, IntegrationEventProps } from "./integration-event";

/**
 * All events use the walletId as aggregateId: the wallet is the unit of
 * concurrency, so consumers that need ordering can partition by it.
 */
interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  const data: TransactionEventData = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
  };
  if (tx.referenceExternalTransactionId) data.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  if (tx.referenceTransactionId) data.referenceTransactionId = tx.referenceTransactionId;
  return data;
}

function base(aggregateId: string, ctx: EventContext) {
  return {
    eventId: ctx.newId(),
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
  };
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  balance: MoneyProps;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...base(tx.walletId, ctx),
      data: {
        ...transactionData(tx),
        balance: wallet.balance.toJSON(),
        processedAt: (tx.processedAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...base(tx.walletId, ctx),
      data: { ...transactionData(tx), failureCode: tx.failureCode as FailureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceAttempts: number;
  nextRetryAt: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...base(tx.walletId, ctx),
      data: {
        ...transactionData(tx),
        referenceAttempts: tx.referenceAttempts,
        nextRetryAt: (tx.nextRetryAt ?? ctx.occurredAt).toISOString(),
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...base(wallet.id, ctx),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
