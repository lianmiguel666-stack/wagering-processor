import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";
import { createRunner, resetSchema } from "../support/database";
import { buildTestApp, openWallet, RecordingPublisher, submit, TestApp, wager } from "../support/fixtures";

let runner: SqlTransactionRunner;
let app: TestApp;

beforeAll(async () => {
  runner = await createRunner({ max: 30 });
  await resetSchema(runner);
  app = buildTestApp(runner);
});

afterAll(async () => {
  await runner.close();
});

async function pendingCount(): Promise<number> {
  const rows = await runner.run((sql) =>
    sql.query("SELECT COUNT(*)::int AS n FROM outbox_messages WHERE published_at IS NULL"),
  );
  return Number(rows[0]?.n);
}

async function drain(relays: Array<{ runOnce: () => Promise<unknown> }>): Promise<void> {
  for (let i = 0; i < 50 && (await pendingCount()) > 0; i++) {
    await Promise.all(relays.map((r) => r.runOnce()));
  }
}

describe("transactional outbox", () => {
  test("events are only visible to the relay after the business transaction commits", async () => {
    const wallet = await openWallet(app, "10.00");
    const publisher = new RecordingPublisher();
    await drain([app.outboxRelay(publisher, "relay-0")]);
    const before = publisher.published.length;
    await submit(app, wager(wallet, { money: { amount: "1.00", currency: "BRL" } }));
    await drain([app.outboxRelay(publisher, "relay-0")]);
    const types = publisher.published.slice(before).map((e) => e.eventType).sort();
    expect(types).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    // Envelope shape (stable, versioned JSON).
    const event = publisher.published.at(-1)!;
    expect(event).toMatchObject({ aggregateId: wallet.id, version: 1 });
    expect(typeof event.occurredAt).toBe("string");
  });

  test("concurrent publishers on the same outbox publish every event exactly once (no crash)", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(app, "100.00")));
    await Promise.all(
      wallets.flatMap((w) => Array.from({ length: 5 }, () => submit(app, wager(w, { money: { amount: "1.00", currency: "BRL" } })))),
    );
    const publisher = new RecordingPublisher();
    const relays = Array.from({ length: 4 }, (_, i) => app.outboxRelay(publisher, `relay-${i}`));
    await drain(relays);
    expect(await pendingCount()).toBe(0);
    const ids = publisher.published.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length); // SKIP LOCKED + lease ⇒ no double publish without a crash
  });

  test("crash after commit and before publish: another instance takes over after the lease", async () => {
    const wallet = await openWallet(app, "10.00");
    const publisher = new RecordingPublisher();
    await drain([app.outboxRelay(publisher, "warmup")]);

    await submit(app, wager(wallet, { money: { amount: "1.00", currency: "BRL" } }));
    // Instance A claims (lease) and "dies" before publishing.
    const claimed = await app.uow.transactional((repos) => repos.outbox.claimDue(app.clock.now(), 100, 2_000, "instance-A"));
    expect(claimed.length).toBe(2);

    // Instance B cannot see them while the lease is valid...
    const relayB = app.outboxRelay(publisher, "instance-B");
    expect((await relayB.runOnce()).claimed).toBe(0);

    // ...and takes over once it expires.
    app.clock.advance(2_500);
    const run = await relayB.runOnce();
    expect(run.published).toBe(2);
    expect(await pendingCount()).toBe(0);

    // A comes back and tries to record a publish it never did: rejected (lost lease).
    const stale = claimed[0]!;
    stale.markPublished(app.clock.now());
    const saved = await app.uow.transactional((repos) => repos.outbox.saveAttempt(stale, "instance-A"));
    expect(saved).toBe(false);
  });

  test("publish failure schedules a retry with backoff; duplicates stay identifiable by eventId", async () => {
    const wallet = await openWallet(app, "10.00");
    const publisher = new RecordingPublisher();
    await drain([app.outboxRelay(publisher, "warmup2")]);
    await submit(app, wager(wallet, { money: { amount: "1.00", currency: "BRL" } }));

    publisher.failNext = 2;
    const relay = app.outboxRelay(publisher, "retry-relay");
    const first = await relay.runOnce();
    expect(first.failed).toBe(2);
    const rows = await runner.run((sql) =>
      sql.query("SELECT attempts, next_attempt_at, last_error FROM outbox_messages WHERE published_at IS NULL"),
    );
    expect(rows.every((r) => Number(r.attempts) === 1 && r.last_error)).toBe(true);

    app.clock.advance(100);
    await drain([relay]);
    expect(await pendingCount()).toBe(0);
  });
});
