/**
 * Base class for every error raised by the domain.
 *
 * Domain errors are *expected* outcomes (invalid input, broken invariant,
 * business rule violation). Infrastructure failures never extend this class.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Input that can never be valid (malformed amount, unknown kind, ...). */
export class InvalidArgumentError extends DomainError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(expected: string, received: string) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(walletId: string) {
    super(`wallet ${walletId} has insufficient funds`);
  }
}

/**
 * Programming error: someone tried to move a transaction out of a terminal
 * state. This is *not* a business path and must never be mapped to a 4xx.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(transactionId: string, from: string, to: string) {
    super(`transaction ${transactionId} cannot transition from ${from} to ${to}`);
  }
}

export class LedgerEntryUnbalancedError extends DomainError {
  readonly code = "LEDGER_ENTRY_UNBALANCED";

  constructor() {
    super("ledger entry arithmetic does not hold: balanceBefore ± money !== balanceAfter");
  }
}
