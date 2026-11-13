import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { UniqueViolationError } from "../../src/application/errors";
import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";
import { DOWN_0001, UP_0001 } from "../../src/infrastructure/persistence/migrations/sql/0001-initial-schema.sql";
import { createRunner, resetSchema } from "../support/database";
import { buildTestApp, openWallet, submit, TestApp, wager } from "../support/fixtures";

/**
 * The guarantees of section 6 are enforced by the schema itself. These tests
 * bypass the application and hit the tables directly to prove it.
 */
let runner: SqlTransactionRunner;
let app: TestApp;

beforeAll(async () => {
  runner = await createRunner();
  await resetSchema(runner);
  app = buildTestApp(runner);
});

afterAll(async () => {
  await runner.close();
});

async function expectSqlError(sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  let error: unknown;
  try {
    await runner.run((tx) => tx.query(sql, params));
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  const text = `${String(error)} ${String((error as { cause?: unknown }).cause ?? "")}`;
  expect(text).toMatch(pattern);
}

describe("migrations", () => {
  test("are reversible: down then up leaves a working schema", async () => {
    await runner.run(async (sql) => {
      await sql.query(DOWN_0001);
      const after = await sql.query("SELECT to_regclass('public.wallets') AS t");
      expect(after[0]?.t).toBeNull();
      await sql.query(UP_0001);
    });
    const rows = await runner.run((sql) => sql.query("SELECT to_regclass('public.wallet_ledger_entries') AS t"));
    expect(String(rows[0]?.t)).toBe("wallet_ledger_entries");
  });
});

describe("wallet constraints", () => {
  test("balance can never be negative (CHECK)", async () => {
    const wallet = await openWallet(app, "10.00");
    await expectSqlError(
      "UPDATE wallets SET balance = -1, version = version + 1 WHERE id = ?",
      [wallet.id],
      /check|wallets_balance_check|violates/i,
    );
  });

  test("one wallet per player + currency (UNIQUE)", async () => {
    const wallet = await openWallet(app, "0.00");
    let error: unknown;
    try {
      await runner.run((sql) =>
        sql.query(
          "INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, 'BRL', 0, 1, now(), now())",
          [randomUUID(), wallet.playerId],
        ),
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe("uq_wallets_player_currency");
  });

  test("balance cannot change without a ledger entry for that version (deferred trigger)", async () => {
    const wallet = await openWallet(app, "50.00");
    await expectSqlError(
      "UPDATE wallets SET balance = 999, version = version + 1 WHERE id = ?",
      [wallet.id],
      /no matching ledger entry/i,
    );
  });

  test("version only moves together with balance, by exactly one", async () => {
    const wallet = await openWallet(app, "50.00");
    await expectSqlError("UPDATE wallets SET version = version + 1 WHERE id = ?", [wallet.id], /version may only change/i);
    await expectSqlError("UPDATE wallets SET balance = 40, version = version + 2 WHERE id = ?", [wallet.id], /exactly 1/i);
  });

  test("wallets cannot be deleted", async () => {
    const wallet = await openWallet(app, "0.00");
    await expectSqlError("DELETE FROM wallets WHERE id = ?", [wallet.id], /cannot be deleted/i);
  });
});

describe("ledger constraints", () => {
  test("ledger rows are append-only: UPDATE, DELETE and TRUNCATE are rejected", async () => {
    const wallet = await openWallet(app, "20.00");
    await expectSqlError("UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?", [wallet.id], /append-only/i);
    await expectSqlError("DELETE FROM wallet_ledger_entries WHERE wallet_id = ?", [wallet.id], /append-only/i);
    await expectSqlError("TRUNCATE wallet_ledger_entries", [], /append-only/i);
  });

  test("an entry must be arithmetically balanced", async () => {
    const wallet = await openWallet(app, "0.00");
    const bet = await submit(app, wager(wallet, { kind: "WIN", money: { amount: "5.00", currency: "BRL" } }));
    await expectSqlError(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, 'CREDIT', 5, 'BRL', 5, 11, 3, now())`,
      [randomUUID(), wallet.id, bet.transactionId],
      /ck_ledger_balanced/i,
    );
  });

  test("one entry per transaction and per wallet version (UNIQUE)", async () => {
    const wallet = await openWallet(app, "0.00");
    const win = await submit(app, wager(wallet, { kind: "WIN", money: { amount: "5.00", currency: "BRL" } }));
    await expectSqlError(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, 'CREDIT', 5, 'BRL', 5, 10, 3, now())`,
      [randomUUID(), wallet.id, win.transactionId],
      /uq_ledger_transaction_wallet|duplicate/i,
    );
  });

  test("the chain must continue from the previous balance_after", async () => {
    const wallet = await openWallet(app, "0.00");
    await submit(app, wager(wallet, { kind: "WIN", money: { amount: "5.00", currency: "BRL" } }));
    const other = await submit(app, wager(wallet, { kind: "WIN", money: { amount: "7.00", currency: "BRL" } }));
    // A forged third line that does not continue from balance 12.00.
    await expectSqlError(
      `INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
       VALUES (?, ?, ?, 'CREDIT', 7, 'BRL', 0, 7, 4, now())`,
      [randomUUID(), wallet.id, other.transactionId],
      /chain broken|uq_ledger_transaction_wallet/i,
    );
  });
});

describe("transaction constraints", () => {
  test("idempotency key and (provider, external id) are unique", async () => {
    const wallet = await openWallet(app, "100.00");
    const input = wager(wallet);
    const result = await submit(app, input);
    const row = (await runner.run((sql) => sql.query("SELECT * FROM wager_transactions WHERE id = ?", [result.transactionId])))[0]!;
    await expectSqlError(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, created_at, updated_at)
       VALUES (?, 'provider-a', 'another-id', ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PENDING', now(), now())`,
      [randomUUID(), row.idempotency_key, row.payload_hash, wallet.id, wallet.playerId],
      /uq_wager_tx_idempotency_key/,
    );
  });

  test("REFUND/ROLLBACK require a reference; OPENING is reserved to the internal provider", async () => {
    const wallet = await openWallet(app, "100.00");
    await expectSqlError(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, created_at, updated_at)
       VALUES (?, 'p', ?, ?, ?, ?, ?, 'r', 'g', 'REFUND', 1, 'BRL', 'PENDING', now(), now())`,
      [randomUUID(), randomUUID(), randomUUID(), "a".repeat(64), wallet.id, wallet.playerId],
      /ck_wager_tx_reference_required/,
    );
    await expectSqlError(
      `INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, created_at, updated_at)
       VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'r', 'g', 'OPENING', 1, 'BRL', 'PENDING', now(), now())`,
      [randomUUID(), randomUUID(), randomUUID(), "a".repeat(64), wallet.id, wallet.playerId],
      /ck_wager_tx_opening_internal/,
    );
  });

  test("terminal transactions are immutable and rows cannot be deleted", async () => {
    const wallet = await openWallet(app, "100.00");
    const result = await submit(app, wager(wallet));
    await expectSqlError(
      "UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'X' WHERE id = ?",
      [result.transactionId],
      /terminal/i,
    );
    await expectSqlError("DELETE FROM wager_transactions WHERE id = ?", [result.transactionId], /cannot be deleted/i);
  });

  test("a reference can be reverted only once (partial unique index)", async () => {
    const indexes = await runner.run((sql) =>
      sql.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_wager_tx_single_reversal'"),
    );
    expect(String(indexes[0]?.indexdef)).toContain("UNIQUE");
  });
});
