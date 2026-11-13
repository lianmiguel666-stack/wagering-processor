import { Money } from "../money/money";
import { InvalidArgumentError, LedgerEntryUnbalancedError } from "../shared/domain-error";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Wallet version *after* this entry was applied. */
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  /** Monotonic sequence assigned by the database (cursor for pagination). */
  sequence?: string;
}

/**
 * Immutable ledger line. No mutable fields and no transition methods:
 * immutability is structural. The database additionally rejects UPDATE and
 * DELETE on the table (see migration).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
    public readonly sequence: string | undefined,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidArgumentError("ledger entry amount must be positive", "money");
    }
    if (props.balanceAfter.isNegative() || props.balanceBefore.isNegative()) {
      throw new InvalidArgumentError("ledger balances cannot be negative", "balanceAfter");
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
      undefined,
    );
    if (!entry.isBalanced()) {
      throw new LedgerEntryUnbalancedError();
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
      state.sequence,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Signed effect on the balance (credit positive, debit negative). */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
