import { WalletBalanceChanged } from "../../domain/events/wagering-events";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, MoneyProps } from "../../domain/money/money";
import { InvalidArgumentError } from "../../domain/shared/domain-error";
import { WagerTransaction } from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { UnitOfWork } from "../ports/repositories";
import { AppLogger, Clock, IdGenerator } from "../ports/runtime";
import { hashCanonical } from "../services/payload-hash";
import { requiredUuid } from "./wager-command";

export interface CreateWalletInput {
  playerId: unknown;
  initialBalance: unknown;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

/**
 * Opens a wallet. A positive initial balance produces, in the same SQL
 * transaction, an internal OPENING transaction, its CREDIT ledger entry and a
 * WalletBalanceChanged event. Duplicate (playerId, currency) is rejected by a
 * unique constraint and surfaces as WalletAlreadyExistsError.
 */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: AppLogger,
  ) {}

  async execute(input: CreateWalletInput, correlationId: string): Promise<WalletView> {
    if (input === null || typeof input !== "object") {
      throw new InvalidArgumentError("body must be an object");
    }
    const playerId = requiredUuid(input.playerId, "playerId");
    const initialBalance = Money.from(input.initialBalance as MoneyProps);

    const wallet = await this.uow.transactional(async (repos) => {
      const at = this.clock.now();
      const walletId = this.ids.next();
      const openingTxId = initialBalance.isPositive() ? this.ids.next() : undefined;
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId,
        initialBalance,
        openingTransactionId: openingTxId,
        openingEntryId: openingTxId ? this.ids.next() : undefined,
        at,
      });

      await repos.wallets.insert(wallet);

      if (openingEntry && openingTxId) {
        const opening = WagerTransaction.opening({
          id: openingTxId,
          walletId,
          playerId,
          money: initialBalance,
          payloadHash: hashCanonical({ kind: "OPENING", walletId, playerId, money: initialBalance.toJSON() }),
          correlationId,
          at,
        });
        await repos.transactions.insert(opening);
        await repos.ledger.append(openingEntry);
        const event = WalletBalanceChanged.from(wallet, openingEntry, {
          newId: () => this.ids.next(),
          correlationId,
          occurredAt: at,
        });
        await repos.outbox.enqueue([OutboxMessage.enqueue(event)]);
      }
      return wallet;
    });

    this.logger.info("wallet created", { walletId: wallet.id, currency: wallet.currency });
    return toWalletView(wallet);
  }
}
