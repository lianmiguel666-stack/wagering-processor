import { TransientInfrastructureError, UniqueViolationError } from "../../../application/errors";

/**
 * SQLSTATE classes/codes we treat as transient (safe to retry the whole
 * transaction): connection exceptions, serialization failures, deadlocks,
 * lock timeouts, cancellations caused by timeouts, server shutting down,
 * resource exhaustion.
 */
const TRANSIENT_SQLSTATE = new Map<string, string>([
  ["40001", "serialization_failure"],
  ["40P01", "deadlock_detected"],
  ["55P03", "lock_timeout"],
  ["57014", "statement_timeout"],
  ["57P01", "admin_shutdown"],
  ["57P02", "crash_shutdown"],
  ["57P03", "cannot_connect_now"],
  ["53300", "too_many_connections"],
  ["53400", "configuration_limit_exceeded"],
]);

const TRANSIENT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_POSTGRES_IDLE_TIMEOUT",
]);

interface ErrorLike {
  code?: unknown;
  errno?: unknown;
  constraint?: unknown;
  constraint_name?: unknown;
  message?: unknown;
  previous?: unknown;
  cause?: unknown;
}

/** Walks wrapper chains (MikroORM DriverException.previous, Error.cause). */
function chain(error: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    out.push(current as ErrorLike);
    const e = current as ErrorLike;
    current = e.previous ?? e.cause;
  }
  return out;
}

function sqlState(error: unknown): string | undefined {
  for (const e of chain(error)) {
    for (const candidate of [e.code, e.errno]) {
      if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
    }
  }
  return undefined;
}

function constraintName(error: unknown): string {
  for (const e of chain(error)) {
    const c = e.constraint ?? e.constraint_name;
    if (typeof c === "string" && c.length > 0) return c;
    const match = typeof e.message === "string" ? /constraint "([^"]+)"/.exec(e.message) : null;
    if (match?.[1]) return match[1];
  }
  return "unknown";
}

export function isLockTimeout(error: unknown): boolean {
  return error instanceof TransientInfrastructureError && error.reason === "lock_timeout";
}

/** Converts driver errors to application-level signals; everything else is returned unchanged. */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof TransientInfrastructureError || error instanceof UniqueViolationError) return error;

  const state = sqlState(error);
  if (state === "23505") {
    return new UniqueViolationError(constraintName(error), error);
  }
  if (state) {
    const reason = TRANSIENT_SQLSTATE.get(state) ?? (state.startsWith("08") ? "connection_exception" : undefined);
    if (reason) return new TransientInfrastructureError(`database: ${reason}`, reason, error);
  }
  for (const e of chain(error)) {
    if (typeof e.code === "string" && (TRANSIENT_NODE_CODES.has(e.code) || e.code.startsWith("ERR_POSTGRES_CONNECTION"))) {
      return new TransientInfrastructureError(`database unreachable (${e.code})`, "connection_exception", error);
    }
    const message = typeof e.message === "string" ? e.message : "";
    if (/Connection terminated|connection.*(closed|refused|timeout)|Knex: Timeout acquiring a connection|Unable to acquire a connection|pool is (destroyed|draining)/i.test(message)) {
      return new TransientInfrastructureError("database connection problem", "connection_exception", error);
    }
  }
  return error;
}
