import { SQL } from "bun";
import { translateDatabaseError } from "../../src/infrastructure/persistence/sql/database-errors";
import { Row, SqlExecutor, SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";

/**
 * Test-only SqlTransactionRunner on Bun's native PostgreSQL client.
 *
 * The default test driver is MikroORM (same as production). This one exists
 * so the repository SQL, schema and concurrency tests can run against a real
 * PostgreSQL without the ORM installed (TEST_DB_DRIVER=bun-sql). It executes
 * the very same repositories; only the transport differs.
 */
export function toPositional(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

class BunSqlExecutor implements SqlExecutor {
  constructor(private readonly sql: SQL) {}

  async query<T extends Row = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    try {
      const rows = await this.sql.unsafe(toPositional(text), [...params]);
      return [...rows] as T[];
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

export class BunSqlTransactionRunner implements SqlTransactionRunner {
  private readonly sql: SQL;

  constructor(
    url: string,
    private readonly options: { lockTimeoutMs: number; max?: number } = { lockTimeoutMs: 5_000 },
  ) {
    this.sql = new SQL({ url, max: options.max ?? 20 });
  }

  run<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx) => {
      const executor = new BunSqlExecutor(tx as unknown as SQL);
      await executor.query(`SET LOCAL lock_timeout = '${this.options.lockTimeoutMs}ms'`);
      return work(executor);
    }) as Promise<T>;
  }

  async ping(): Promise<void> {
    await this.sql.unsafe("SELECT 1");
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
