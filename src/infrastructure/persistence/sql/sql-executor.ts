export type Row = Record<string, unknown>;

/**
 * Minimal SQL port used by the repositories. Placeholders are positional `?`
 * (Knex/MikroORM style). Implementations translate driver errors with
 * {@link translateDatabaseError}.
 */
export interface SqlExecutor {
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/** Runs `work` inside one database transaction (commit on return, rollback on throw). */
export interface SqlTransactionRunner {
  run<T>(work: (sql: SqlExecutor) => Promise<T>): Promise<T>;
  /** Cheap connectivity probe for readiness checks. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
