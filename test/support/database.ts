import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";
import { DOWN_0001, UP_0001 } from "../../src/infrastructure/persistence/migrations/sql/0001-initial-schema.sql";

/**
 * Integration tests run against a REAL PostgreSQL (docker compose service
 * `postgres`, or any URL in TEST_DATABASE_URL). Nothing is mocked.
 *
 * TEST_DB_DRIVER=mikro-orm (default) uses the production adapter;
 * TEST_DB_DRIVER=bun-sql uses Bun's native client with the same repositories.
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering_test";

export async function createRunner(options: { max?: number; lockTimeoutMs?: number } = {}): Promise<SqlTransactionRunner> {
  const driver = process.env.TEST_DB_DRIVER ?? "mikro-orm";
  if (driver === "bun-sql") {
    const { BunSqlTransactionRunner } = await import("./bun-sql-runner");
    return new BunSqlTransactionRunner(TEST_DATABASE_URL, { lockTimeoutMs: options.lockTimeoutMs ?? 10_000, max: options.max });
  }
  const { initOrm, MikroOrmTransactionRunner } = await import("../../src/infrastructure/persistence/mikro-orm/mikro-orm");
  const { loadConfig } = await import("../../src/infrastructure/config/app-config");
  const config = loadConfig({ ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_POOL_MAX: String(options.max ?? 20) });
  const orm = await initOrm(config);
  return new MikroOrmTransactionRunner(orm, { lockTimeoutMs: options.lockTimeoutMs ?? 10_000, statementTimeoutMs: 30_000 });
}

/** Drops and recreates the schema from the migration SQL (fresh state per test file). */
export async function resetSchema(runner: SqlTransactionRunner): Promise<void> {
  await runner.run(async (sql) => {
    await sql.query("SELECT pg_advisory_xact_lock(424242)"); // serialise parallel test files
    await sql.query(DOWN_0001);
    await sql.query(UP_0001);
  });
}

/**
 * A runner pointing at a port where nothing listens: every transaction fails
 * with a connection error, exactly like a PostgreSQL outage. (Closing a pool
 * is not equivalent: the ORM may transparently reconnect.)
 */
export async function createUnreachableRunner(): Promise<SqlTransactionRunner> {
  const deadUrl = TEST_DATABASE_URL.replace(/@([^:/]+)(:\d+)?\//, "@$1:1/");
  const driver = process.env.TEST_DB_DRIVER ?? "mikro-orm";
  if (driver === "bun-sql") {
    const { BunSqlTransactionRunner } = await import("./bun-sql-runner");
    return new BunSqlTransactionRunner(deadUrl, { lockTimeoutMs: 1_000, max: 1 });
  }
  const { initOrm, MikroOrmTransactionRunner } = await import("../../src/infrastructure/persistence/mikro-orm/mikro-orm");
  const { loadConfig } = await import("../../src/infrastructure/config/app-config");
  const orm = await initOrm(loadConfig({ ...process.env, DATABASE_URL: deadUrl, DB_POOL_MAX: "1" }));
  return new MikroOrmTransactionRunner(orm, { lockTimeoutMs: 1_000, statementTimeoutMs: 1_000 });
}
