import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, EntityManager, MikroORM, Options } from "@mikro-orm/postgresql";
import { AppConfig } from "../../config/app-config";
import { translateDatabaseError } from "../sql/database-errors";
import { Row, SqlExecutor, SqlTransactionRunner } from "../sql/sql-executor";
import { Migration20261112000000InitialSchema } from "../migrations/Migration20261112000000InitialSchema";

/**
 * MikroORM configuration.
 *
 * What MikroORM is used for here:
 *  - connection pool and driver (PostgreSQL via Knex);
 *  - transaction demarcation: `em.fork().transactional()`; every statement
 *    executed through the forked EntityManager joins that transaction;
 *  - versioned, reversible migrations (Migrator, explicit migrationsList).
 *
 * What it is deliberately NOT used for: change-set computation on flush.
 * The write path needs compare-and-set UPDATEs, `SELECT … FOR UPDATE`,
 * `FOR UPDATE SKIP LOCKED` claims and `INSERT … ON CONFLICT DO NOTHING`.
 * Expressing those as explicit SQL in the repositories keeps one write model
 * and makes every statement on the money path reviewable. See ARCHITECTURE.md.
 */
export function createOrmOptions(config: AppConfig): Options {
  return defineConfig({
    clientUrl: config.database.url,
    // Connect lazily: the process boots (and /health/ready reports "down")
    // while PostgreSQL is temporarily unavailable, instead of crash-looping.
    connect: false,
    // The schema is owned by migrations; never create databases implicitly.
    ensureDatabase: false,
    entities: [],
    discovery: { warnWhenNoEntities: false },
    pool: { min: config.database.poolMin, max: config.database.poolMax },
    extensions: [Migrator],
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      migrationsList: [
        { name: "Migration20261112000000InitialSchema", class: Migration20261112000000InitialSchema },
      ],
    },
    allowGlobalContext: false,
    debug: false,
  });
}

export async function initOrm(config: AppConfig): Promise<MikroORM> {
  return MikroORM.init(createOrmOptions(config));
}

class MikroOrmSqlExecutor implements SqlExecutor {
  constructor(private readonly em: EntityManager) {}

  async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    try {
      return (await this.em.execute(sql, [...params], "all")) as unknown as T[];
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

export class MikroOrmTransactionRunner implements SqlTransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: { lockTimeoutMs: number; statementTimeoutMs: number },
  ) {}

  run<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      const executor = new MikroOrmSqlExecutor(em);
      // Bounded waits: a hot wallet makes callers queue on its row lock; a
      // lock_timeout turns pathological waits into a retryable error (55P03).
      await executor.query(`SET LOCAL lock_timeout = '${Math.trunc(this.options.lockTimeoutMs)}ms'`);
      await executor.query(`SET LOCAL statement_timeout = '${Math.trunc(this.options.statementTimeoutMs)}ms'`);
      return work(executor);
    });
  }

  async ping(): Promise<void> {
    await new MikroOrmSqlExecutor(this.orm.em.fork()).query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}
