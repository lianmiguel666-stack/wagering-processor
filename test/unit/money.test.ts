import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { CurrencyMismatchError, InvalidArgumentError } from "../../src/domain/shared/domain-error";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money", () => {
  test("parses and serialises with a fixed scale of 2", () => {
    expect(brl("25").toString()).toBe("25.00");
    expect(brl("25.5").toString()).toBe("25.50");
    expect(brl("25.05").toJSON()).toEqual({ amount: "25.05", currency: "BRL" });
    expect(brl("0").toString()).toBe("0.00");
    expect(brl("999999999999999999.99").toString()).toBe("999999999999999999.99");
  });

  test.each([
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["1e3"],
    ["1E-2"],
    [""],
    [" "],
    ["10.005"],
    ["10.123"],
    ["-1.00"],
    ["+1.00"],
    ["01.00"],
    ["1,00"],
    [".50"],
    ["1."],
    ["0x10"],
    ["1 000.00"],
    ["1000000000000000000.00"], // 19 integer digits > numeric(20,2)
  ])("rejects invalid amount %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidArgumentError);
  });

  test("rejects non-string amounts (numbers are never accepted for money)", () => {
    expect(() => Money.from({ amount: 10 as unknown as string, currency: "BRL" })).toThrow(InvalidArgumentError);
    expect(() => Money.from({ amount: 0.1 as unknown as string, currency: "BRL" })).toThrow(InvalidArgumentError);
    expect(() => Money.from(null as unknown as { amount: string; currency: string })).toThrow(InvalidArgumentError);
  });

  test("rejects invalid currency codes", () => {
    for (const currency of ["brl", "BR", "BRLL", "", "12A"]) {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidArgumentError);
    }
  });

  test("arithmetic is exact (no floating point): 0.10 + 0.20 = 0.30", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.toString()).toBe("10.00");
    expect(brl("100.00").subtract(brl("0.01")).toString()).toBe("99.99");
  });

  test("never rounds: precision beyond the scale is rejected, not rounded", () => {
    expect(() => brl("0.015")).toThrow(InvalidArgumentError);
    expect(() => brl("0.999")).toThrow(InvalidArgumentError);
  });

  test("negative results are representable internally and serialised with sign", () => {
    const negative = brl("1.00").subtract(brl("2.50"));
    expect(negative.isNegative()).toBe(true);
    expect(negative.toString()).toBe("-1.50");
    expect(brl("3.00").negate().toString()).toBe("-3.00");
    expect(Money.zero("BRL").negate().isZero()).toBe(true);
  });

  test("comparisons", () => {
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.01").isLessThan(brl("1.01"))).toBe(false);
    expect(brl("1.10").equals(brl("1.1"))).toBe(true);
    expect(brl("1.00").equals(Money.from({ amount: "1.00", currency: "USD" }))).toBe(false);
    expect(brl("0.00").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
  });

  test("operations across currencies throw a domain error", () => {
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  test("is immutable: operations return new instances", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.toString()).toBe("10.00");
    expect(b).not.toBe(a);
  });
});
