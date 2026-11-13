import { describe, expect, test } from "bun:test";
import { Money } from "../../src/domain/money/money";
import { InvalidArgumentError, InvalidTransactionStateError } from "../../src/domain/shared/domain-error";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { SettlementOutcome, WagerSettlement } from "../../src/domain/wagering/wager-settlement";
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-01-01T00:00:00Z");
let n = 0;

function wallet(amount = "100.00"): Wallet {
  return Wallet.open({ id: "w1", playerId: "p1", initialBalance: brl(amount), openingTransactionId: "o", openingEntryId: "oe", at }).wallet;
}

function tx(kind: K, amount: string, extra: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  n++;
  return WagerTransaction.create({
    id: `id-${n}`,
    providerId: "prov",
    externalTransactionId: `ext-${n}`,
    idempotencyKey: `prov:ext-${n}`,
    payloadHash: "h".repeat(64),
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind,
    money: brl(amount),
    createdAt: at,
    ...extra,
  });
}

function settle(t: WagerTransaction, w: Wallet, reference?: WagerTransaction | null, reversed = false): SettlementOutcome {
  return WagerSettlement.settle({ transaction: t, wallet: w, reference, referenceAlreadyReversed: reversed, ledgerEntryId: `le-${++n}`, at });
}

/** A BET already applied to `w`. */
function processedBet(w: Wallet, amount = "20.00"): WagerTransaction {
  const bet = tx(K.Bet, amount);
  expect(settle(bet, w).type).toBe("processed");
  return bet;
}

describe("BET", () => {
  test("debits and produces one DEBIT entry", () => {
    const w = wallet();
    const bet = tx(K.Bet, "25.00");
    const out = settle(bet, w);
    expect(out.type === "processed" && out.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe("75.00");
    expect(bet.status).toBe(S.Processed);
    expect(bet.resultBalance?.toString()).toBe("75.00");
  });

  test("insufficient funds → REJECTED INSUFFICIENT_FUNDS, no movement", () => {
    const w = wallet("10.00");
    const bet = tx(K.Bet, "10.01");
    expect(settle(bet, w)).toEqual({ type: "rejected", failureCode: FailureCode.InsufficientFunds });
    expect(w.balance.toString()).toBe("10.00");
    expect(w.version).toBe(1);
  });

  test("cannot carry a reference", () => {
    expect(() => tx(K.Bet, "1.00", { referenceExternalTransactionId: "x" })).toThrow(InvalidArgumentError);
  });
});

describe("WIN", () => {
  test("credits, with or without a reference to the round's BET", () => {
    const w = wallet();
    const bet = processedBet(w);
    const win = tx(K.Win, "50.00", { referenceExternalTransactionId: bet.externalTransactionId });
    const out = settle(win, w, bet);
    expect(out.type === "processed" && out.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe("130.00");
    settle(tx(K.Win, "1.00"), w);
    expect(w.balance.toString()).toBe("131.00");
  });

  test("zero amount is rejected", () => {
    expect(() => tx(K.Win, "0.00")).toThrow(InvalidArgumentError);
  });
});

describe("LOSS", () => {
  test("is processed without touching balance or ledger", () => {
    const w = wallet();
    const loss = tx(K.Loss, "0.00");
    expect(loss.affectsBalance()).toBe(false);
    expect(settle(loss, w)).toEqual({ type: "processed" });
    expect(w.version).toBe(1);
    expect(loss.status).toBe(S.Processed);
  });
});

describe("REFUND", () => {
  test("requires a reference", () => {
    expect(() => tx(K.Refund, "1.00")).toThrow(InvalidArgumentError);
  });

  test("credits back a processed BET", () => {
    const w = wallet();
    const bet = processedBet(w);
    const refund = tx(K.Refund, "20.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, w, bet).type).toBe("processed");
    expect(w.balance.toString()).toBe("100.00");
  });

  test("only once", () => {
    const w = wallet();
    const bet = processedBet(w);
    const refund = tx(K.Refund, "20.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, w, bet, true)).toEqual({ type: "rejected", failureCode: FailureCode.ReferenceAlreadyReversed });
  });

  test("only of a BET, same amount, same round/player/wallet/currency", () => {
    const w = wallet();
    const bet = processedBet(w);
    const win = tx(K.Win, "5.00");
    settle(win, w);
    const cases: Array<[WagerTransaction, WagerTransaction, FailureCode]> = [
      [tx(K.Refund, "5.00", { referenceExternalTransactionId: win.externalTransactionId }), win, FailureCode.ReferenceKindNotAllowed],
      [tx(K.Refund, "19.99", { referenceExternalTransactionId: bet.externalTransactionId }), bet, FailureCode.ReferenceAmountMismatch],
      [tx(K.Refund, "20.00", { referenceExternalTransactionId: bet.externalTransactionId, roundId: "r2" }), bet, FailureCode.ReferenceMismatch],
    ];
    for (const [refund, reference, code] of cases) {
      expect(settle(refund, w, reference)).toEqual({ type: "rejected", failureCode: code });
    }
  });

  test("missing or not-yet-applied reference → awaiting-reference", () => {
    const w = wallet();
    const refund = tx(K.Refund, "20.00", { referenceExternalTransactionId: "later" });
    expect(settle(refund, w, null)).toEqual({ type: "awaiting-reference" });
    expect(refund.status).toBe(S.Pending); // caller applies the retry policy
    const pendingBet = tx(K.Bet, "20.00");
    expect(settle(tx(K.Refund, "20.00", { referenceExternalTransactionId: pendingBet.externalTransactionId }), w, pendingBet)).toEqual({ type: "awaiting-reference" });
  });

  test("reference that was REJECTED → REFERENCE_NOT_PROCESSED", () => {
    const w = wallet("1.00");
    const bet = tx(K.Bet, "20.00");
    settle(bet, w);
    expect(bet.status).toBe(S.Rejected);
    const refund = tx(K.Refund, "20.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(settle(refund, w, bet)).toEqual({ type: "rejected", failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe("ROLLBACK", () => {
  test("of a BET credits; of a WIN or REFUND debits", () => {
    const w = wallet();
    const bet = processedBet(w);
    const rbBet = tx(K.Rollback, "20.00", { referenceExternalTransactionId: bet.externalTransactionId });
    expect(rbBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = tx(K.Win, "30.00");
    settle(win, w);
    const rbWin = tx(K.Rollback, "30.00", { referenceExternalTransactionId: win.externalTransactionId });
    expect(rbWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(settle(rbWin, w, win).type).toBe("processed");
    expect(w.balance.toString()).toBe("80.00");
  });

  test("cannot reference another ROLLBACK or a LOSS", () => {
    const w = wallet();
    const bet = processedBet(w);
    const rb = tx(K.Rollback, "20.00", { referenceExternalTransactionId: bet.externalTransactionId });
    settle(rb, w, bet);
    const rbOfRb = tx(K.Rollback, "20.00", { referenceExternalTransactionId: rb.externalTransactionId });
    expect(settle(rbOfRb, w, rb)).toEqual({ type: "rejected", failureCode: FailureCode.ReferenceKindNotAllowed });
  });

  test("that would drive the balance negative → REVERSAL_INSUFFICIENT_FUNDS (distinct from INSUFFICIENT_FUNDS)", () => {
    const w = wallet("0.00");
    const win = tx(K.Win, "50.00");
    settle(win, w);
    settle(tx(K.Bet, "45.00"), w);
    const rb = tx(K.Rollback, "50.00", { referenceExternalTransactionId: win.externalTransactionId });
    expect(settle(rb, w, win)).toEqual({ type: "rejected", failureCode: FailureCode.ReversalInsufficientFunds });
    expect(w.balance.toString()).toBe("5.00");
  });
});

describe("ownership and currency", () => {
  test("currency conflict is a business rejection", () => {
    const w = wallet();
    const usdBet = tx(K.Bet, "1.00", { money: Money.from({ amount: "1.00", currency: "USD" }) });
    expect(settle(usdBet, w)).toEqual({ type: "rejected", failureCode: FailureCode.CurrencyMismatch });
  });

  test("player must own the wallet", () => {
    const w = wallet();
    expect(settle(tx(K.Bet, "1.00", { playerId: "intruder" }), w)).toEqual({ type: "rejected", failureCode: FailureCode.PlayerWalletMismatch });
  });
});

describe("WagerTransaction state machine", () => {
  test("terminal states cannot transition (programming error)", () => {
    const t = tx(K.Bet, "1.00");
    t.reject(FailureCode.InsufficientFunds, at, brl("0"));
    expect(t.isTerminal()).toBe(true);
    expect(() => t.markProcessed(undefined, at, brl("0"))).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.ProcessingFailed, at)).toThrow(InvalidTransactionStateError);
  });

  test("PENDING_REFERENCE counts attempts and can then be settled", () => {
    const t = tx(K.Refund, "1.00", { referenceExternalTransactionId: "x" });
    t.markPendingReference(new Date(at.getTime() + 1000), at, brl("5.00"));
    t.markPendingReference(new Date(at.getTime() + 2000), at, brl("5.00"));
    expect(t.referenceAttempts).toBe(2);
    t.reject(FailureCode.ReferenceNotFound, at, brl("5.00"));
    expect(t.status).toBe(S.Rejected);
  });

  test("OPENING is internal and born PROCESSED", () => {
    const opening = WagerTransaction.opening({ id: "o", walletId: "w", playerId: "p", money: brl("1.00"), payloadHash: "x", at });
    expect(opening.status).toBe(S.Processed);
    expect(opening.providerId).toBe("internal");
  });

  test("same idempotency key with a different payload is detected", () => {
    const t = tx(K.Bet, "1.00", { payloadHash: "a".repeat(64) });
    expect(t.matchesPayload("a".repeat(64))).toBe(true);
    expect(t.matchesPayload("b".repeat(64))).toBe(false);
  });
});
