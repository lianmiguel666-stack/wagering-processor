import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidArgumentError,
  LedgerEntryUnbalancedError,
} from "../../src/domain/shared/domain-error";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00Z");
let seq = 0;
const movement = (amount: string) => ({ entryId: `e${++seq}`, transactionId: `t${seq}`, money: brl(amount), at });

function open(amount: string) {
  return Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(amount), openingTransactionId: "o1", openingEntryId: "oe1", at });
}

describe("Wallet", () => {
  test("opens at version 1; a positive initial balance comes with its opening CREDIT entry", () => {
    const { wallet, openingEntry } = open("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe("100.00");
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.balanceBefore.toString()).toBe("0.00");
  });

  test("zero initial balance → no opening entry", () => {
    const { wallet, openingEntry } = Wallet.open({ id: "w", playerId: "p", initialBalance: brl("0"), at });
    expect(openingEntry).toBeUndefined();
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("debit and credit return the ledger entry and bump version exactly once", () => {
    const { wallet } = open("100.00");
    const debit = wallet.debit(movement("30.00"));
    expect(debit).toMatchObject({ direction: LedgerDirection.Debit, walletVersion: 2 });
    expect(debit.balanceBefore.toString()).toBe("100.00");
    expect(debit.balanceAfter.toString()).toBe("70.00");
    const credit = wallet.credit(movement("5.50"));
    expect(credit.balanceAfter.toString()).toBe("75.50");
    expect(wallet.version).toBe(3);
    expect(wallet.balance.toString()).toBe("75.50");
  });

  test("balance never goes negative; failed debit leaves the aggregate untouched", () => {
    const { wallet } = open("10.00");
    expect(() => wallet.debit(movement("10.01"))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe("10.00");
    expect(wallet.version).toBe(1);
    wallet.debit(movement("10.00"));
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("operation currency must equal wallet currency", () => {
    const { wallet } = open("10.00");
    const usd = { ...movement("1.00"), money: Money.from({ amount: "1.00", currency: "USD" }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
  });

  test("zero-amount movements are rejected (version only moves with the balance)", () => {
    const { wallet } = open("10.00");
    expect(() => wallet.credit(movement("0.00"))).toThrow(InvalidArgumentError);
    expect(wallet.version).toBe(1);
  });

  test("rehydrate reconstructs state without revalidating", () => {
    const wallet = Wallet.rehydrate({ id: "w", playerId: "p", currency: "BRL", balance: brl("5.00"), version: 9, createdAt: at, updatedAt: at });
    expect(wallet.version).toBe(9);
  });

  test("sum of ledger entries always equals the balance", () => {
    const { wallet, openingEntry } = open("50.00");
    const entries = [openingEntry!];
    for (const [kind, amount] of [["d", "20.00"], ["c", "7.25"], ["d", "37.25"], ["c", "1.00"]] as const) {
      entries.push(kind === "d" ? wallet.debit(movement(amount)) : wallet.credit(movement(amount)));
    }
    const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero("BRL"));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
  });
});

describe("WalletLedgerEntry", () => {
  const base = { id: "e", walletId: "w", transactionId: "t", walletVersion: 2, createdAt: at };

  test("factory validates the arithmetic", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl("5.00"), balanceBefore: brl("1.00"), balanceAfter: brl("7.00") }),
    ).toThrow(LedgerEntryUnbalancedError);
    const ok = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl("5.00"), balanceBefore: brl("6.00"), balanceAfter: brl("1.00") });
    expect(ok.isBalanced()).toBe(true);
  });

  test("rejects non-positive amounts", () => {
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl("0"), balanceBefore: brl("1.00"), balanceAfter: brl("1.00") }),
    ).toThrow(InvalidArgumentError);
  });

  test("is structurally immutable (readonly fields, frozen-by-design)", () => {
    const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl("1.00"), balanceBefore: brl("0"), balanceAfter: brl("1.00") });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(entry));
    expect(methods.sort()).toEqual(["constructor", "isBalanced", "signedAmount"]);
  });
});
