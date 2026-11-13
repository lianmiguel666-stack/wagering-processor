import { TransactionalRepositories, UnitOfWork } from "../../application/ports/repositories";
import { Metrics } from "../../application/ports/runtime";
import {
  SqlInboxRepository,
  SqlLedgerRepository,
  SqlOutboxRepository,
  SqlWagerTransactionRepository,
  SqlWalletRepository,
} from "./repositories/sql-repositories";
import { isLockTimeout, translateDatabaseError } from "./sql/database-errors";
import { SqlExecutor, SqlTransactionRunner } from "./sql/sql-executor";

export function createRepositories(sql: SqlExecutor): TransactionalRepositories {
  return {
    wallets: new SqlWalletRepository(sql),
    transactions: new SqlWagerTransactionRepository(sql),
    ledger: new SqlLedgerRepository(sql),
    inbox: new SqlInboxRepository(sql),
    outbox: new SqlOutboxRepository(sql),
  };
}

/**
 * UnitOfWork adapter: one database transaction per `transactional` call,
 * every repository bound to it. Errors raised at COMMIT time (deferred
 * constraint triggers, serialization failures) are translated too.
 */
export class SqlUnitOfWork implements UnitOfWork {
  constructor(
    private readonly runner: SqlTransactionRunner,
    private readonly metrics?: Metrics,
  ) {}

  async transactional<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.runner.run((sql) => work(createRepositories(sql)));
    } catch (error) {
      const translated = translateDatabaseError(error);
      if (isLockTimeout(translated)) this.metrics?.lockConflict();
      throw translated;
    }
  }
}
