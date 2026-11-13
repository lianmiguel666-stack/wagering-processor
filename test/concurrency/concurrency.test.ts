import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { IdempotencyConflictError } from "../../src/application/errors";
import { parseSubmitWagerInput } from "../../src/application/use-cases/wager-command";
import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";
import { createRunner, resetSchema, TEST_DATABASE_URL } from "../support/database";
import { assertLedgerConsistent, buildTestApp, openWallet, submit, TestApp, wager } from "../support/fixtures";

/**
 * Real parallelism: every call below runs on its own pooled connection and
 * the database arbitrates. No sequential mocks.
 */
let runner: SqlTransactionRunner;
let app: TestApp;

beforeAll(async () => {
  runner = await createRunner({ max: 60, lockTimeoutMs: 30_000 });
  await resetSchema(runner);
  app = buildTestApp(runner);
});

afterAll(async () => {
  await runner.close();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function debitEntries(walletId: string): Promise<number> {
  const rows = await runner.run((sql) =>
    sql.query("SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [walletId]),
  );
  return Number(rows[0]?.n);
}

describe("mandatory scenario (section 8)", () => {
  test("100.00 balance, two simultaneous 80.00 bets → one PROCESSED, one REJECTED, final 20.00", async () => {
    for (let round = 0; round < 10; round++) {
      const wallet = await openWallet(app, "100.00");
      const results = await Promise.all([
        submit(app, wager(wallet, { money: brl("80.00") })),
        submit(app, wager(wallet, { money: brl("80.00") })),
      ]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
      expect(results.find((r) => r.status === "REJECTED")?.failureCode).toBe("INSUFFICIENT_FUNDS");
      expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("20.00"));
      expect(await debitEntries(wallet.id)).toBe(1);

      // Retrying both requests never duplicates the debit.
      await Promise.all(results.map((_, i) => submit(app, wager(wallet, { money: brl("80.00") })).catch(() => i)));
      await assertLedgerConsistent(app, wallet.id);
    }
  });
});

describe("idempotency under contention", () => {
  test("the same bet sent 50 times in parallel debits once", async () => {
    const wallet = await openWallet(app, "1000.00");
    const input = wager(wallet, { money: brl("25.00") });
    const results = await Promise.all(Array.from({ length: 50 }, () => submit(app, input)));
    const ids = new Set(results.map((r) => r.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === "PROCESSED" && r.balance?.amount === "975.00")).toBe(true);
    expect(await debitEntries(wallet.id)).toBe(1);
    expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("975.00"));
    await assertLedgerConsistent(app, wallet.id);
  });

  test("50 parallel deliveries of the same queue message: one effect, the rest are inbox hits or replays", async () => {
    const wallet = await openWallet(app, "1000.00");
    const command = parseSubmitWagerInput(wager(wallet, { money: brl("10.00") }));
    const inbox = { consumerName: "c", messageId: `msg-${randomUUID()}`, payloadHash: command.payloadHash };
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => app.process.execute(command, { source: "sqs", correlationId: "c", inbox })),
    );
    const effects = outcomes.filter((o) => o.type === "result" && !o.result.idempotentReplay);
    expect(effects).toHaveLength(1);
    expect(await debitEntries(wallet.id)).toBe(1);
    await assertLedgerConsistent(app, wallet.id);
  });

  test("same idempotency key used concurrently on two different wallets: one wins, the other conflicts", async () => {
    const a = await openWallet(app, "100.00");
    const b = await openWallet(app, "100.00");
    const key = `shared-${randomUUID()}`;
    const settled = await Promise.allSettled([
      submit(app, wager(a, { idempotencyKey: key, externalTransactionId: `x-${randomUUID()}` })),
      submit(app, wager(b, { idempotencyKey: key, externalTransactionId: `y-${randomUUID()}` })),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(IdempotencyConflictError);
    await assertLedgerConsistent(app, a.id);
    await assertLedgerConsistent(app, b.id);
  });
});

describe("hot wallet and parallel wallets", () => {
  test("hot wallet: 200 concurrent mixed operations never overdraw and stay consistent", async () => {
    const wallet = await openWallet(app, "500.00");
    const ops = Array.from({ length: 200 }, (_, i) =>
      i % 4 === 0
        ? wager(wallet, { kind: "WIN", money: brl("7.00") })
        : wager(wallet, { kind: "BET", money: brl("13.00") }),
    );
    const results = await Promise.all(ops.map((op) => submit(app, op)));
    const processed = results.filter((r) => r.status === "PROCESSED");
    const view = await app.queries.getWallet(wallet.id);
    expect(Number(view.balance.amount)).toBeGreaterThanOrEqual(0);
    expect(view.version).toBe(1 + processed.length);
    await assertLedgerConsistent(app, wallet.id);
  });

  test("distinct wallets are processed in parallel (no global lock)", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(app, "100.00")));

    // Hold the lock of wallet[0] in a long transaction...
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const blocker = app.uow.transactional(async (repos) => {
      await repos.wallets.findByIdForUpdate(wallets[0]!.id);
      await held;
    });
    await Bun.sleep(50);

    // ...while every other wallet still completes.
    const started = performance.now();
    const results = await Promise.all(wallets.slice(1).map((w) => submit(app, wager(w, { money: brl("10.00") }))));
    const elapsed = performance.now() - started;
    expect(results.every((r) => r.status === "PROCESSED")).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    release();
    await blocker;
    for (const w of wallets) await assertLedgerConsistent(app, w.id);
  });

  test("concurrent REFUND and ROLLBACK of the same BET: exactly one reversal wins", async () => {
    for (let i = 0; i < 10; i++) {
      const wallet = await openWallet(app, "100.00");
      const betId = `bet-${randomUUID()}`;
      await submit(app, wager(wallet, { externalTransactionId: betId, money: brl("40.00") }));
      const results = await Promise.all([
        submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("40.00") })),
        submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: betId, money: brl("40.00") })),
        submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("40.00") })),
      ]);
      expect(results.filter((r) => r.status === "PROCESSED")).toHaveLength(1);
      expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("100.00"));
      await assertLedgerConsistent(app, wallet.id);
    }
  });

  test("ROLLBACK delivered before its BET, concurrently with the BET", async () => {
    for (let i = 0; i < 10; i++) {
      const wallet = await openWallet(app, "100.00");
      const betId = `bet-${randomUUID()}`;
      const [rollback] = await Promise.all([
        submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: betId, money: brl("30.00") })),
        submit(app, wager(wallet, { externalTransactionId: betId, money: brl("30.00") })),
      ]);
      // Whatever the arrival order, the end state is the same.
      app.clock.advance(5_000);
      await app.resolvePending.runOnce();
      const final = await app.queries.getTransaction(rollback.transactionId);
      expect(final.status).toBe("PROCESSED");
      expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("100.00"));
      await assertLedgerConsistent(app, wallet.id);
    }
  });
});

describe("multiple instances (separate OS processes)", () => {
  test("≥3 processes hammering the same wallets keep every invariant", async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => openWallet(app, "300.00")));
    const shared = wager(wallets[0]!, { money: brl("50.00") }); // same idempotency key in every process
    const spec = JSON.stringify({ wallets, shared, opsPerWallet: 30 });

    const processes = Array.from({ length: 4 }, (_, i) =>
      Bun.spawn(["bun", "run", `${import.meta.dir}/../support/instance-runner.ts`], {
        env: { ...process.env, TEST_DATABASE_URL, INSTANCE: String(i), SPEC: spec },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const exits = await Promise.all(processes.map((p) => p.exited));
    const stderr = await Promise.all(processes.map((p) => new Response(p.stderr).text()));
    expect(exits, stderr.join("\n")).toEqual([0, 0, 0, 0]);
    const outputs = await Promise.all(processes.map(async (p) => JSON.parse(await new Response(p.stdout).text())));

    // The shared bet was applied exactly once across all processes.
    const sharedResults = outputs.map((o) => o.shared);
    expect(new Set(sharedResults.map((r) => r.transactionId)).size).toBe(1);
    expect(sharedResults.filter((r) => !r.idempotentReplay)).toHaveLength(1);

    for (const w of wallets) {
      const view = await app.queries.getWallet(w.id);
      expect(Number(view.balance.amount)).toBeGreaterThanOrEqual(0);
      await assertLedgerConsistent(app, w.id);
    }
  }, 60_000);
});

describe("crash recovery", () => {
  test("worker killed after commit and before ack: redelivery is absorbed by the inbox", async () => {
    const wallet = await openWallet(app, "100.00");
    const command = parseSubmitWagerInput(wager(wallet, { money: brl("10.00") }));
    const inbox = { consumerName: "c", messageId: `msg-${randomUUID()}`, payloadHash: command.payloadHash };

    // Child process commits and exits hard before it could ack.
    const child = Bun.spawn(["bun", "run", `${import.meta.dir}/../support/commit-then-die.ts`], {
      env: { ...process.env, TEST_DATABASE_URL, COMMAND: JSON.stringify(wager(wallet, { externalTransactionId: command.externalTransactionId, money: brl("10.00") })), INBOX: JSON.stringify(inbox) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await child.exited;
    expect(code, await new Response(child.stderr).text()).toBe(137);

    // The broker redelivers the very same message to another instance.
    const redelivery = await app.process.execute(command, { source: "sqs", correlationId: "c", inbox });
    expect(redelivery.type).toBe("duplicate-message");
    expect(await debitEntries(wallet.id)).toBe(1);
    expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("90.00"));
    await assertLedgerConsistent(app, wallet.id);
  }, 30_000);

  test("service restart: a new connection pool sees a consistent final state", async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(app, "100.00")));
    await Promise.all(wallets.map((w) => submit(app, wager(w, { money: brl("33.33") }))));

    const restarted = await createRunner();
    try {
      const fresh = buildTestApp(restarted);
      for (const w of wallets) {
        const report = await fresh.reconcile.execute(w.id);
        expect(report).toMatchObject({ consistent: true, storedBalance: brl("66.67"), checkedEntries: 2 });
      }
      // Global invariant across the whole database.
      const rows = await restarted.run((sql) =>
        sql.query(`
          SELECT COUNT(*)::int AS bad FROM wallets w
           WHERE w.balance <> COALESCE((SELECT SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END)
                                          FROM wallet_ledger_entries e WHERE e.wallet_id = w.id), 0)`),
      );
      expect(Number(rows[0]?.bad)).toBe(0);
    } finally {
      await restarted.close();
    }
  });
});
