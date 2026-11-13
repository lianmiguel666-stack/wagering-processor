import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { silentLogger } from "../../src/application/ports/runtime";
import { WagerMessageHandler } from "../../src/infrastructure/messaging/wager-message-handler";
import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";
import { createRunner, createUnreachableRunner, resetSchema } from "../support/database";
import { buildTestApp, CountingMetrics, openWallet, TestApp, wager } from "../support/fixtures";

/**
 * Consumer decision logic (ack / retry / dead-letter) against a real
 * PostgreSQL. The SQS transport itself is covered by test/sqs (LocalStack).
 */
let runner: SqlTransactionRunner;
let app: TestApp;
let handler: WagerMessageHandler;
const options = { consumerName: "wager-consumer", maxReceiveCount: 3, retryBaseDelaySeconds: 2 };

beforeAll(async () => {
  runner = await createRunner();
  await resetSchema(runner);
  app = buildTestApp(runner);
  handler = new WagerMessageHandler(app.process, app.metrics, silentLogger, options);
});

afterAll(async () => {
  await runner.close();
});

function message(data: object, messageId = `msg-${randomUUID()}`): string {
  return JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data });
}

describe("WagerMessageHandler", () => {
  test("valid message → processed and acked; redelivery → acked as duplicate without effect", async () => {
    const wallet = await openWallet(app, "100.00");
    const body = message(wager(wallet, { money: { amount: "25.00", currency: "BRL" } }));
    expect(await handler.handle(body, 1)).toEqual({ action: "ack", reason: "processed" });
    expect(await handler.handle(body, 2)).toEqual({ action: "ack", reason: "duplicate_message" });
    expect((await app.queries.getWallet(wallet.id)).balance.amount).toBe("75.00");
  });

  test("business rejection is terminal → ack", async () => {
    const wallet = await openWallet(app, "1.00");
    expect(await handler.handle(message(wager(wallet, { money: { amount: "5.00", currency: "BRL" } })), 1)).toEqual({
      action: "ack",
      reason: "rejected",
    });
  });

  test("idempotency conflict and unknown wallet are terminal → ack", async () => {
    const wallet = await openWallet(app, "100.00");
    const input = wager(wallet);
    await handler.handle(message(input), 1);
    const conflict = await handler.handle(message({ ...input, money: { amount: "99.00", currency: "BRL" } }), 1);
    expect(conflict).toEqual({ action: "ack", reason: "idempotency_key_conflict" });
    const ghost = await handler.handle(message(wager({ id: randomUUID(), playerId: randomUUID() })), 1);
    expect(ghost).toEqual({ action: "ack", reason: "wallet_not_found" });
  });

  test("malformed messages are permanent failures → dead-letter immediately", async () => {
    const wallet = await openWallet(app, "100.00");
    expect((await handler.handle("{not json", 1)).action).toBe("dead-letter");
    expect((await handler.handle(JSON.stringify({ type: "Other", messageId: "x", data: {} }), 1)).action).toBe("dead-letter");
    expect((await handler.handle(message({ ...wager(wallet), kind: "OPENING" }), 1)).action).toBe("dead-letter");
    expect((await handler.handle(message({ ...wager(wallet), money: { amount: 25, currency: "BRL" } }), 1)).action).toBe(
      "dead-letter",
    );
    expect(app.metrics.get("dlq:invalid_payload")).toBeGreaterThanOrEqual(2);
  });

  test("database down → transient: retry with exponential backoff, then DLQ after maxReceiveCount", async () => {
    const deadRunner = await createUnreachableRunner();
    const deadApp = buildTestApp(deadRunner);
    const metrics = new CountingMetrics();
    const deadHandler = new WagerMessageHandler(deadApp.process, metrics, silentLogger, options);
    const body = message(wager({ id: randomUUID(), playerId: randomUUID() }));

    expect(await deadHandler.handle(body, 1)).toMatchObject({ action: "retry", delaySeconds: 2 });
    expect(await deadHandler.handle(body, 2)).toMatchObject({ action: "retry", delaySeconds: 4 });
    const last = await deadHandler.handle(body, 3);
    expect(last.action).toBe("dead-letter");
    expect(last.reason).toStartWith("retries_exhausted:");
    expect(metrics.get("retry:sqs_connection_exception")).toBe(2);
    await deadRunner.close().catch(() => {});
  });
});
