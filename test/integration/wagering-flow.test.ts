import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DuplicateExternalTransactionIdError,
  IdempotencyConflictError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../src/application/errors";
import { parseSubmitWagerInput } from "../../src/application/use-cases/wager-command";
import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";
import { createRunner, resetSchema } from "../support/database";
import {
  assertLedgerConsistent,
  buildTestApp,
  openWallet,
  submit,
  TestApp,
  wager,
} from "../support/fixtures";

let runner: SqlTransactionRunner;
let app: TestApp;

beforeAll(async () => {
  runner = await createRunner();
  await resetSchema(runner);
  app = buildTestApp(runner, { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 4_000 });
});

afterAll(async () => {
  await runner.close();
});

const brl = (amount: string) => ({ amount, currency: "BRL" });

async function outboxTypes(walletId: string): Promise<string[]> {
  const rows = await runner.run((sql) =>
    sql.query("SELECT event_type FROM outbox_messages WHERE aggregate_id = ? ORDER BY occurred_at, id", [walletId]),
  );
  return rows.map((r) => String(r.event_type));
}

async function ledgerCount(walletId: string): Promise<number> {
  const rows = await runner.run((sql) =>
    sql.query("SELECT COUNT(*)::int AS n FROM wallet_ledger_entries WHERE wallet_id = ?", [walletId]),
  );
  return Number(rows[0]?.n);
}

describe("wallet creation", () => {
  test("positive initial balance creates OPENING tx + CREDIT entry + event atomically", async () => {
    const wallet = await openWallet(app, "1000.00");
    expect(wallet.balance).toEqual(brl("1000.00"));
    expect(wallet.version).toBe(1);
    const ledger = await app.queries.getLedger(wallet.id, undefined, 50);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]).toMatchObject({ direction: "CREDIT", money: brl("1000.00"), walletVersion: 1 });
    expect(await outboxTypes(wallet.id)).toEqual(["WalletBalanceChanged"]);
    await assertLedgerConsistent(app, wallet.id);
  });

  test("zero initial balance creates no ledger entry", async () => {
    const wallet = await openWallet(app, "0.00");
    expect(await ledgerCount(wallet.id)).toBe(0);
    await assertLedgerConsistent(app, wallet.id);
  });

  test("duplicate player + currency is a conflict; another currency is fine", async () => {
    const wallet = await openWallet(app, "1.00");
    await expect(
      app.createWallet.execute({ playerId: wallet.playerId, initialBalance: brl("5.00") }, "t"),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
    const usd = await app.createWallet.execute(
      { playerId: wallet.playerId, initialBalance: { amount: "5.00", currency: "USD" } },
      "t",
    );
    expect(usd.balance.currency).toBe("USD");
  });
});

describe("BET / WIN / LOSS", () => {
  test("BET debits, WIN credits, LOSS records without moving balance", async () => {
    const wallet = await openWallet(app, "100.00");
    const bet = await submit(app, wager(wallet, { externalTransactionId: `bet-${randomUUID()}`, money: brl("25.00") }));
    expect(bet).toMatchObject({ status: "PROCESSED", balance: brl("75.00"), idempotentReplay: false });

    const win = await submit(app, wager(wallet, { kind: "WIN", money: brl("40.00") }));
    expect(win.balance).toEqual(brl("115.00"));

    const loss = await submit(app, wager(wallet, { kind: "LOSS", money: brl("0.00") }));
    expect(loss).toMatchObject({ status: "PROCESSED", balance: brl("115.00") });

    expect(await ledgerCount(wallet.id)).toBe(3); // opening + bet + win (no LOSS entry)
    const view = await app.queries.getWallet(wallet.id);
    expect(view.version).toBe(3);
    // opening + BET + WIN change the balance; BET, WIN and LOSS are "processed".
    expect((await outboxTypes(wallet.id)).sort()).toEqual([
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
      "WalletBalanceChanged",
    ]);
    await assertLedgerConsistent(app, wallet.id);
  });

  test("BET with insufficient funds is REJECTED, auditable, with no ledger and an event", async () => {
    const wallet = await openWallet(app, "10.00");
    const result = await submit(app, wager(wallet, { money: brl("10.01") }));
    expect(result).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: brl("10.00") });
    const tx = await app.queries.getTransaction(result.transactionId);
    expect(tx.status).toBe("REJECTED");
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await outboxTypes(wallet.id)).toContain("WagerTransactionRejected");
    await assertLedgerConsistent(app, wallet.id);
  });

  test("currency and player mismatches are rejected with distinct codes", async () => {
    const wallet = await openWallet(app, "10.00");
    const ccy = await submit(app, wager(wallet, { money: { amount: "1.00", currency: "USD" } }));
    expect(ccy.failureCode).toBe("CURRENCY_MISMATCH");
    const player = await submit(app, wager(wallet, { playerId: randomUUID() }));
    expect(player.failureCode).toBe("PLAYER_WALLET_MISMATCH");
    await assertLedgerConsistent(app, wallet.id);
  });

  test("unknown wallet is a request error (nothing persisted)", async () => {
    const ghost = { id: randomUUID(), playerId: randomUUID() };
    await expect(submit(app, wager(ghost))).rejects.toBeInstanceOf(WalletNotFoundError);
  });
});

describe("idempotency", () => {
  test("identical request replays the original result, including the balance observed then", async () => {
    const wallet = await openWallet(app, "100.00");
    const input = wager(wallet, { money: brl("30.00") });
    const first = await submit(app, input);
    await submit(app, wager(wallet, { money: brl("5.00") })); // balance moves on afterwards
    const replay = await submit(app, input);
    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance).toEqual(brl("70.00"));
    expect(await ledgerCount(wallet.id)).toBe(3);
    expect(app.metrics.get("dup:idempotency_replay")).toBeGreaterThan(0);
  });

  test("same key with a different payload is a conflict, not a replay", async () => {
    const wallet = await openWallet(app, "100.00");
    const input = wager(wallet, { money: brl("30.00") });
    await submit(app, input);
    await expect(submit(app, { ...input, money: brl("31.00") })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test("replay of a REJECTED transaction returns the same rejection", async () => {
    const wallet = await openWallet(app, "1.00");
    const input = wager(wallet, { money: brl("5.00") });
    const first = await submit(app, input);
    const again = await submit(app, input);
    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(again.failureCode).toBe("INSUFFICIENT_FUNDS");
  });

  test("same (provider, external id) under another idempotency key is a conflict", async () => {
    const wallet = await openWallet(app, "100.00");
    const input = wager(wallet);
    await submit(app, input);
    await expect(submit(app, { ...input, idempotencyKey: "other-key" })).rejects.toBeInstanceOf(
      DuplicateExternalTransactionIdError,
    );
  });

  test("amount normalisation: '25' and '25.00' hash identically", () => {
    const wallet = { id: randomUUID(), playerId: randomUUID() };
    const a = parseSubmitWagerInput(wager(wallet, { externalTransactionId: "x", money: brl("25") }));
    const b = parseSubmitWagerInput(wager(wallet, { externalTransactionId: "x", money: brl("25.00") }));
    expect(a.payloadHash).toBe(b.payloadHash);
  });
});

describe("REFUND / ROLLBACK", () => {
  test("REFUND reverts a processed BET exactly once", async () => {
    const wallet = await openWallet(app, "100.00");
    const betId = `bet-${randomUUID()}`;
    await submit(app, wager(wallet, { externalTransactionId: betId, money: brl("20.00") }));
    const refund = await submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("20.00") }));
    expect(refund).toMatchObject({ status: "PROCESSED", balance: brl("100.00") });

    const second = await submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("20.00") }));
    expect(second.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    // A BET already refunded cannot be rolled back either (stricter, documented).
    const rollback = await submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: betId, money: brl("20.00") }));
    expect(rollback.failureCode).toBe("REFERENCE_ALREADY_REVERSED");
    await assertLedgerConsistent(app, wallet.id);
  });

  test("REFUND must reference a BET, with the same amount and round", async () => {
    const wallet = await openWallet(app, "100.00");
    const winId = `win-${randomUUID()}`;
    await submit(app, wager(wallet, { kind: "WIN", externalTransactionId: winId, money: brl("5.00") }));
    const wrongKind = await submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: winId, money: brl("5.00") }));
    expect(wrongKind.failureCode).toBe("REFERENCE_KIND_NOT_ALLOWED");

    const betId = `bet-${randomUUID()}`;
    await submit(app, wager(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    const partial = await submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("5.00") }));
    expect(partial.failureCode).toBe("REFERENCE_AMOUNT_MISMATCH");
    const otherRound = await submit(app, wager(wallet, { kind: "REFUND", roundId: "round-2", referenceExternalTransactionId: betId, money: brl("10.00") }));
    expect(otherRound.failureCode).toBe("REFERENCE_MISMATCH");
    await assertLedgerConsistent(app, wallet.id);
  });

  test("ROLLBACK inverts the referenced movement (BET → credit, WIN → debit)", async () => {
    const wallet = await openWallet(app, "100.00");
    const betId = `bet-${randomUUID()}`;
    const winId = `win-${randomUUID()}`;
    await submit(app, wager(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    await submit(app, wager(wallet, { kind: "WIN", externalTransactionId: winId, referenceExternalTransactionId: betId, money: brl("30.00") }));
    const rbWin = await submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: winId, money: brl("30.00") }));
    expect(rbWin.balance).toEqual(brl("90.00"));
    const rbBet = await submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: betId, money: brl("10.00") }));
    expect(rbBet.balance).toEqual(brl("100.00"));
    const ledger = await app.queries.getLedger(wallet.id, undefined, 50);
    expect(ledger.items.map((e) => e.direction)).toEqual(["CREDIT", "DEBIT", "CREDIT", "DEBIT", "CREDIT"]);
    await assertLedgerConsistent(app, wallet.id);
  });

  test("ROLLBACK that would make the balance negative is rejected with its own code", async () => {
    const wallet = await openWallet(app, "0.00");
    const winId = `win-${randomUUID()}`;
    await submit(app, wager(wallet, { kind: "WIN", externalTransactionId: winId, money: brl("50.00") }));
    await submit(app, wager(wallet, { money: brl("45.00") }));
    const rollback = await submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: winId, money: brl("50.00") }));
    expect(rollback).toMatchObject({ status: "REJECTED", failureCode: "REVERSAL_INSUFFICIENT_FUNDS", balance: brl("5.00") });
    await assertLedgerConsistent(app, wallet.id);
  });

  test("reverting a REJECTED reference is REFERENCE_NOT_PROCESSED", async () => {
    const wallet = await openWallet(app, "1.00");
    const betId = `bet-${randomUUID()}`;
    await submit(app, wager(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    const refund = await submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("10.00") }));
    expect(refund.failureCode).toBe("REFERENCE_NOT_PROCESSED");
  });
});

describe("out-of-order references", () => {
  test("REFUND before its BET is parked, then settled immediately when the BET arrives", async () => {
    const wallet = await openWallet(app, "100.00");
    const betId = `bet-${randomUUID()}`;
    const refund = await submit(app, wager(wallet, { kind: "REFUND", referenceExternalTransactionId: betId, money: brl("20.00") }));
    expect(refund).toMatchObject({ status: "PENDING_REFERENCE", balance: brl("100.00") });

    await submit(app, wager(wallet, { externalTransactionId: betId, money: brl("20.00") }));
    const settled = await app.queries.getTransaction(refund.transactionId);
    expect(settled).toMatchObject({ status: "PROCESSED", balance: brl("100.00") });
    expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("100.00"));
    expect(await outboxTypes(wallet.id)).toContain("WagerTransactionPendingReference");
    await assertLedgerConsistent(app, wallet.id);
  });

  test("worker retries with backoff and rejects with REFERENCE_NOT_FOUND after the limit", async () => {
    const wallet = await openWallet(app, "100.00");
    const pending = await submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: `nope-${randomUUID()}`, money: brl("1.00") }));
    expect(pending.status).toBe("PENDING_REFERENCE");

    // Not due yet: nothing happens.
    let run = await app.resolvePending.runOnce();
    const before = await app.queries.getTransaction(pending.transactionId);
    expect(before.referenceAttempts).toBe(1);

    for (let i = 0; i < 5; i++) {
      app.clock.advance(10_000);
      run = await app.resolvePending.runOnce();
    }
    const final = await app.queries.getTransaction(pending.transactionId);
    expect(final).toMatchObject({ status: "REJECTED", failureCode: "REFERENCE_NOT_FOUND", referenceAttempts: 3 });
    expect(await outboxTypes(wallet.id)).toContain("WagerTransactionRejected");
    expect(run.claimed).toBeGreaterThanOrEqual(0);
    await assertLedgerConsistent(app, wallet.id);
  });

  test("worker settles a parked transaction once its reference exists", async () => {
    const wallet = await openWallet(app, "100.00");
    const betId = `bet-${randomUUID()}`;
    const winId = `win-${randomUUID()}`;
    await submit(app, wager(wallet, { externalTransactionId: betId, money: brl("10.00") }));
    // ROLLBACK of a WIN that has not arrived yet.
    const rb = await submit(app, wager(wallet, { kind: "ROLLBACK", referenceExternalTransactionId: winId, money: brl("30.00") }));
    expect(rb.status).toBe("PENDING_REFERENCE");
    // The WIN arrives and the dependent is settled inline.
    await submit(app, wager(wallet, { kind: "WIN", externalTransactionId: winId, money: brl("30.00") }));
    expect((await app.queries.getTransaction(rb.transactionId)).status).toBe("PROCESSED");
    expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("90.00"));
    await assertLedgerConsistent(app, wallet.id);
  });
});

describe("inbox (queue entry)", () => {
  test("a redelivered message (same messageId) is detected and has no effect", async () => {
    const wallet = await openWallet(app, "100.00");
    const command = parseSubmitWagerInput(wager(wallet, { money: brl("10.00") }));
    const inbox = { consumerName: "test-consumer", messageId: `msg-${randomUUID()}`, payloadHash: command.payloadHash };
    const first = await app.process.execute(command, { source: "sqs", correlationId: "c", inbox });
    const second = await app.process.execute(command, { source: "sqs", correlationId: "c", inbox });
    expect(first.type).toBe("result");
    expect(second.type).toBe("duplicate-message");
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test("a different messageId with the same idempotency key is an idempotent replay", async () => {
    const wallet = await openWallet(app, "100.00");
    const command = parseSubmitWagerInput(wager(wallet, { money: brl("10.00") }));
    await app.process.execute(command, { source: "sqs", correlationId: "c", inbox: { consumerName: "c", messageId: randomUUID(), payloadHash: "h" } });
    const replay = await app.process.execute(command, { source: "sqs", correlationId: "c", inbox: { consumerName: "c", messageId: randomUUID(), payloadHash: "h" } });
    expect(replay.type === "result" && replay.result.idempotentReplay).toBe(true);
  });
});

describe("atomicity", () => {
  test("a failure after the financial writes rolls back wallet, transaction, ledger, inbox and outbox", async () => {
    const wallet = await openWallet(app, "100.00");
    const command = parseSubmitWagerInput(wager(wallet, { money: brl("10.00") }));
    const messageId = `msg-${randomUUID()}`;
    const crashingUow = {
      transactional: <T>(work: Parameters<typeof app.uow.transactional<T>>[0]) =>
        app.uow.transactional(async (repos) => {
          await work(repos);
          throw new Error("process died before commit");
        }),
    };
    const { ProcessWagerTransactionUseCase } = await import("../../src/application/use-cases/process-wager-transaction");
    const { WagerProcessor } = await import("../../src/application/services/wager-processor");
    const { UuidV7Generator } = await import("../../src/application/services/system");
    const { noopMetrics, silentLogger } = await import("../../src/application/ports/runtime");
    const ids = new UuidV7Generator();
    const crashing = new ProcessWagerTransactionUseCase(
      crashingUow,
      new WagerProcessor(app.clock, ids),
      app.clock,
      ids,
      noopMetrics,
      silentLogger,
    );
    await expect(
      crashing.execute(command, { source: "sqs", correlationId: "c", inbox: { consumerName: "c", messageId, payloadHash: command.payloadHash } }),
    ).rejects.toThrow("process died before commit");

    const counts = await runner.run((sql) =>
      sql.query(
        `SELECT
           (SELECT COUNT(*) FROM wager_transactions WHERE wallet_id = ? AND kind = 'BET')::int AS txs,
           (SELECT COUNT(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::int AS entries,
           (SELECT COUNT(*) FROM outbox_messages WHERE aggregate_id = ?)::int AS events,
           (SELECT COUNT(*) FROM inbox_messages WHERE message_id = ?)::int AS inbox,
           (SELECT balance FROM wallets WHERE id = ?) AS balance`,
        [wallet.id, wallet.id, wallet.id, messageId, wallet.id],
      ),
    );
    expect(counts[0]).toMatchObject({ txs: 0, entries: 1, events: 1, inbox: 0, balance: "100.00" });

    // The redelivery after the "crash" is processed normally, exactly once.
    const retried = await app.process.execute(command, { source: "sqs", correlationId: "c", inbox: { consumerName: "c", messageId, payloadHash: command.payloadHash } });
    expect(retried.type === "result" && retried.result.status).toBe("PROCESSED");
    expect(await ledgerCount(wallet.id)).toBe(2);
    await assertLedgerConsistent(app, wallet.id);
  });
});

describe("queries", () => {
  test("ledger pagination uses a stable opaque cursor", async () => {
    const wallet = await openWallet(app, "0.00");
    for (let i = 0; i < 7; i++) {
      await submit(app, wager(wallet, { kind: "WIN", money: brl(`${i + 1}.00`) }));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await app.queries.getLedger(wallet.id, cursor, 3);
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    await expect(app.queries.getLedger(wallet.id, "garbage", 3)).rejects.toThrow("invalid cursor");
  });

  test("transaction lookup by provider + external id", async () => {
    const wallet = await openWallet(app, "10.00");
    const input = wager(wallet, { money: brl("1.00") });
    const result = await submit(app, input);
    const view = await app.queries.getTransactionByExternalId("provider-a", String(input.externalTransactionId));
    expect(view.id).toBe(result.transactionId);
  });

  test("reconciliation flags a divergence instead of fixing it", async () => {
    const wallet = await openWallet(app, "10.00");
    // Forge a divergence the only way the schema allows: disable the
    // consistency trigger for this session (superuser) and tamper the balance.
    await runner.run(async (sql) => {
      await sql.query("SET LOCAL session_replication_role = replica");
      await sql.query("UPDATE wallets SET balance = 11.00 WHERE id = ?", [wallet.id]);
    });
    const report = await app.reconcile.execute(wallet.id);
    expect(report).toMatchObject({
      consistent: false,
      storedBalance: brl("11.00"),
      calculatedBalance: brl("10.00"),
      difference: brl("1.00"),
      checkedEntries: 1,
    });
    expect(app.metrics.get("reconciliation:divergence")).toBe(1);
    expect((await app.queries.getWallet(wallet.id)).balance).toEqual(brl("11.00")); // not silently corrected
  });
});
