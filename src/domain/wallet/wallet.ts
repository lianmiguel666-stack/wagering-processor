import { Money } from "../money/money";
import { CurrencyMismatchError, InsufficientFundsError, InvalidArgumentError } from "../shared/domain-error";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MovementProps {
  /** Id of the ledger entry to create. */
  entryId: string;
  /** Financial transaction that causes the movement. */
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * `debit`/`credit` are the only ways to change the balance and each returns
 * the ledger entry describing the change, so balance and ledger cannot drift
 * apart inside the model. `version` starts at 1 and increments exactly once
 * per balance change; the repository uses it as a compare-and-set guard and
 * the schema ties every version > 1 to exactly one ledger entry.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet with balance zero at version 1. The opening credit (if
   * any) is applied by {@link Wallet.open} as the version-1 ledger entry so
   * that the invariant "every balance has a ledger trail" holds from birth.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    openingTransactionId?: string;
    openingEntryId?: string;
    at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (props.initialBalance.isNegative()) {
      throw new InvalidArgumentError("initial balance cannot be negative", "initialBalance");
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      Money.zero(props.initialBalance.currency),
      1,
      props.at,
      props.at,
    );
    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.openingTransactionId || !props.openingEntryId) {
      throw new InvalidArgumentError("a positive initial balance requires an opening transaction", "initialBalance");
    }
    // The opening credit is version 1 (not 2): the wallet is born with it.
    const before = wallet._balance;
    wallet._balance = before.add(props.initialBalance);
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: before,
      balanceAfter: wallet._balance,
      walletVersion: wallet._version,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstruction from persistence — does not revalidate transitions. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(direction: LedgerDirection, props: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    const nextVersion = this._version + 1;
    // Build (and validate) the entry before mutating: if it throws, the
    // aggregate stays untouched.
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: props.at,
    });
    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = props.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidArgumentError("movement amount must be positive", "money");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
