import { MoneyProps } from "../../domain/money/money";
import { InvalidArgumentError } from "../../domain/shared/domain-error";
import { FailureCode } from "../../domain/wagering/failure-code";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { WalletLedgerEntry } from "../../domain/wallet/wallet-ledger-entry";
import { ResourceNotFoundError } from "../errors";
import { UnitOfWork } from "../ports/repositories";
import { requiredUuid } from "./wager-command";
import { toWalletView, WalletView } from "./create-wallet";

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  referenceAttempts: number;
  createdAt: string;
  processedAt?: string;
}

/**
 * Opaque, stable cursor: base64url of the ledger sequence (a bigserial
 * assigned at insert). Sequences never change and are strictly increasing
 * per insert, so pages never skip or repeat entries even while new entries
 * are appended.
 */
export function encodeCursor(sequence: string): string {
  return Buffer.from(`v1:${sequence}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const match = /^v1:(\d{1,19})$/.exec(decoded);
  if (!match) throw new InvalidArgumentError("invalid cursor", "cursor");
  return match[1] as string;
}

export class WalletQueries {
  constructor(private readonly uow: UnitOfWork) {}

  async getWallet(walletId: string): Promise<WalletView> {
    const id = requiredUuid(walletId, "walletId");
    const wallet = await this.uow.transactional((repos) => repos.wallets.findById(id));
    if (!wallet) throw new ResourceNotFoundError("wallet", id);
    return toWalletView(wallet);
  }

  async getLedger(walletId: string, cursor: string | undefined, limitInput: unknown): Promise<LedgerPageView> {
    const id = requiredUuid(walletId, "walletId");
    const limit = limitInput === undefined || limitInput === "" ? 50 : Number(limitInput);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new InvalidArgumentError("limit must be an integer between 1 and 200", "limit");
    }
    const after = cursor ? decodeCursor(cursor) : undefined;
    return this.uow.transactional(async (repos) => {
      const wallet = await repos.wallets.findById(id);
      if (!wallet) throw new ResourceNotFoundError("wallet", id);
      const page = await repos.ledger.listByWallet(id, after, limit);
      return {
        items: page.entries.map(toLedgerEntryView),
        nextCursor: page.nextSequence ? encodeCursor(page.nextSequence) : null,
      };
    });
  }

  async getTransaction(transactionId: string): Promise<TransactionView> {
    const id = requiredUuid(transactionId, "transactionId");
    const tx = await this.uow.transactional((repos) => repos.transactions.findById(id));
    if (!tx) throw new ResourceNotFoundError("transaction", id);
    return toTransactionView(tx);
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const tx = await this.uow.transactional((repos) =>
      repos.transactions.findByProviderAndExternalId(providerId, externalTransactionId),
    );
    if (!tx) throw new ResourceNotFoundError("transaction", `${providerId}/${externalTransactionId}`);
    return toTransactionView(tx);
  }
}

export function toLedgerEntryView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt.toISOString(),
  };
}

export function toTransactionView(tx: WagerTransaction): TransactionView {
  const view: TransactionView = {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    referenceAttempts: tx.referenceAttempts,
    createdAt: tx.createdAt.toISOString(),
  };
  if (tx.failureCode) view.failureCode = tx.failureCode;
  if (tx.referenceExternalTransactionId) view.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  if (tx.referenceTransactionId) view.referenceTransactionId = tx.referenceTransactionId;
  if (tx.resultBalance) view.balance = tx.resultBalance.toJSON();
  if (tx.processedAt) view.processedAt = tx.processedAt.toISOString();
  return view;
}
