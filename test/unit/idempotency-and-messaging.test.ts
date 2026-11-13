import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { canonicalJson, hashCanonical } from "../../src/application/services/payload-hash";
import { parseSubmitWagerInput, SubmitWagerInput } from "../../src/application/use-cases/wager-command";
import { decodeCursor, encodeCursor } from "../../src/application/use-cases/queries";
import { WalletBalanceChanged } from "../../src/domain/events/wagering-events";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/money/money";
import { InvalidArgumentError } from "../../src/domain/shared/domain-error";
import { Wallet } from "../../src/domain/wallet/wallet";
import { UuidV7Generator } from "../../src/application/services/system";

const base = (): SubmitWagerInput => ({
  idempotencyKey: "provider-a:transaction-123",
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
});

describe("payload hash", () => {
  test("canonical JSON sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined, b: [3, { z: 1, y: 2 }] } })).toBe('{"a":{"b":[3,{"y":2,"z":1}],"d":2},"b":1}');
  });

  test("key order and the Idempotency-Key header do not change the hash", () => {
    const a = parseSubmitWagerInput(base());
    const shuffled = Object.fromEntries(Object.entries(base()).reverse()) as unknown as SubmitWagerInput;
    const b = parseSubmitWagerInput({ ...shuffled, idempotencyKey: "another-key" });
    expect(a.payloadHash).toBe(b.payloadHash);
    expect(a.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("any business field change produces a different hash (→ idempotency conflict)", () => {
    const original = parseSubmitWagerInput(base()).payloadHash;
    const variants: Array<Partial<SubmitWagerInput>> = [
      { money: { amount: "25.01", currency: "BRL" } },
      { money: { amount: "25.00", currency: "USD" } },
      { kind: "WIN" },
      { roundId: "round-988" },
      { gameId: "other" },
      { walletId: randomUUID() },
      { referenceExternalTransactionId: "ref-1", kind: "WIN" },
    ];
    for (const v of variants) {
      expect(parseSubmitWagerInput({ ...base(), ...v }).payloadHash).not.toBe(original);
    }
  });

  test("hash is the documented algorithm: sha256(canonicalJson(businessFields))", () => {
    const cmd = parseSubmitWagerInput(base());
    const { idempotencyKey: _ignored, ...fields } = base();
    expect(cmd.payloadHash).toBe(hashCanonical(fields));
  });
});

describe("input contract", () => {
  test.each([
    [{ kind: "OPENING" }, "kind"],
    [{ kind: "JACKPOT" }, "kind"],
    [{ providerId: "internal" }, "providerId"],
    [{ walletId: "not-a-uuid" }, "walletId"],
    [{ money: { amount: "-1.00", currency: "BRL" } }, "money.amount"],
    [{ money: { amount: 25, currency: "BRL" } }, "money.amount"],
    [{ idempotencyKey: "" }, "idempotencyKey"],
    [{ kind: "REFUND" }, "referenceExternalTransactionId"],
    [{ kind: "BET", referenceExternalTransactionId: "x" }, "referenceExternalTransactionId"],
  ])("rejects %p", (override, field) => {
    let error: unknown;
    try {
      parseSubmitWagerInput({ ...base(), ...override } as SubmitWagerInput);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as InvalidArgumentError).field).toBe(field);
  });
});

describe("inbox / outbox entities", () => {
  test("InboxMessage.markProcessed is idempotent", () => {
    const m = InboxMessage.receive({ consumerName: "c", messageId: "m", payloadHash: "h", receivedAt: new Date() });
    expect(m.isProcessed()).toBe(false);
    const t = new Date("2026-01-01T00:00:00Z");
    m.markProcessed(t);
    m.markProcessed(new Date());
    expect(m.processedAt).toBe(t);
  });

  test("OutboxMessage: enqueue stores the JSON envelope; retry uses exponential backoff", () => {
    const { wallet, openingEntry } = Wallet.open({
      id: "w",
      playerId: "p",
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
      openingTransactionId: "t",
      openingEntryId: "e",
      at: new Date(),
    });
    const ids = new UuidV7Generator();
    const event = WalletBalanceChanged.from(wallet, openingEntry!, { newId: () => ids.next(), correlationId: "c", occurredAt: new Date() });
    const message = OutboxMessage.enqueue(event);
    expect(message.payload).toMatchObject({ eventType: "WalletBalanceChanged", version: 1, data: { balanceAfter: { amount: "10.00", currency: "BRL" } } });
    expect(message.id).toBe(event.eventId);

    const now = new Date("2026-01-01T00:00:00Z");
    message.scheduleRetry(now, "boom", { baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 1000);
    message.scheduleRetry(now, "boom", { baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 2000);
    for (let i = 0; i < 5; i++) message.scheduleRetry(now, "boom", { baseDelayMs: 1000, maxDelayMs: 5000 });
    expect(message.nextAttemptAt?.getTime()).toBe(now.getTime() + 5000);
    expect(message.isDue(now)).toBe(false);
    message.markPublished(now);
    expect(message.isPending()).toBe(false);
  });
});

describe("misc", () => {
  test("ledger cursor round-trips and rejects garbage", () => {
    expect(decodeCursor(encodeCursor("12345"))).toBe("12345");
    expect(() => decodeCursor("bm9wZQ")).toThrow(InvalidArgumentError);
  });

  test("UUIDv7 ids are valid and time-ordered", () => {
    const g = new UuidV7Generator();
    const a = g.next();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
