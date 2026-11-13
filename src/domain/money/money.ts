import { CurrencyMismatchError, InvalidArgumentError } from "../shared/domain-error";

/** Contract representation (DTO). */
export interface MoneyProps {
  amount: string; // decimal string with exactly 2 decimal places, ex.: "25.00"
  currency: string; // ISO-4217
}

const SCALE = 2;
const FACTOR = 10n ** BigInt(SCALE);
/** Matches numeric(20,2) in PostgreSQL: up to 18 integer digits. */
const MAX_INTEGER_DIGITS = 18;
/**
 * Plain non-negative decimal: no sign, no exponent, no leading zeros,
 * at most two fractional digits. "25", "25.5" and "25.50" are accepted and
 * normalised to "25.00"/"25.50" on output.
 */
const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Immutable monetary value.
 *
 * Internally the amount is held as an integer number of minor units
 * (`bigint`, scale fixed at 2). This is exact by construction — there is no
 * floating point anywhere in the type — and avoids a runtime dependency on a
 * decimal library inside the domain. Because the scale is fixed and inputs
 * with more than two decimal places are rejected, no operation ever needs to
 * round.
 */
export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Parses a contract value. Rejects NaN, Infinity, scientific notation,
   * empty strings, more than 2 decimal places and negative values.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidArgumentError("money must be an object { amount, currency }", "money");
    }
    const currency = Money.parseCurrency(props.currency);
    const { amount } = props;
    if (typeof amount !== "string") {
      throw new InvalidArgumentError("money.amount must be a decimal string", "money.amount");
    }
    const match = DECIMAL_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidArgumentError(
        `money.amount "${amount}" is not a non-negative decimal with at most ${SCALE} decimal places`,
        "money.amount",
      );
    }
    const integerPart = match[1] as string;
    if (integerPart.length > MAX_INTEGER_DIGITS) {
      throw new InvalidArgumentError("money.amount exceeds the supported magnitude", "money.amount");
    }
    const fraction = (match[2] ?? "").padEnd(SCALE, "0");
    return new Money(BigInt(integerPart) * FACTOR + BigInt(fraction), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  hasSameCurrencyAs(other: Money): boolean {
    return this.currency === other.currency;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Decimal string with exactly two places, e.g. "-12.30". */
  toString(): string {
    const negative = this.minor < 0n;
    const abs = negative ? -this.minor : this.minor;
    const integer = abs / FACTOR;
    const fraction = (abs % FACTOR).toString().padStart(SCALE, "0");
    return `${negative ? "-" : ""}${integer.toString()}.${fraction}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidArgumentError("money.currency must be an ISO-4217 code (3 upper-case letters)", "money.currency");
    }
    return currency;
  }
}
