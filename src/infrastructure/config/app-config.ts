import { hostname } from "node:os";

export type AppRole = "api" | "worker" | "all";

export interface AppConfig {
  role: AppRole;
  instanceId: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  shutdownGraceMs: number;
  database: {
    url: string;
    poolMin: number;
    poolMax: number;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
  };
  aws: {
    region: string;
    endpoint?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
  };
  sqs: {
    wagerQueueName: string;
    deadLetterQueueName: string;
    eventsQueueName: string;
    consumerName: string;
    /** Attempts before a message is dead-lettered (manual + redrive policy). */
    maxReceiveCount: number;
    waitTimeSeconds: number;
    visibilityTimeoutSeconds: number;
    concurrency: number;
    retryBaseDelaySeconds: number;
    autoCreateQueues: boolean;
  };
  outbox: { pollIntervalMs: number; batchSize: number; leaseMs: number };
  pendingReference: {
    pollIntervalMs: number;
    batchSize: number;
    leaseMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

function int(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`env ${key} must be a non-negative integer`);
  return value;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const role = (env.APP_ROLE ?? "all") as AppRole;
  if (!["api", "worker", "all"].includes(role)) throw new Error("APP_ROLE must be api | worker | all");
  const logLevel = (env.LOG_LEVEL ?? "info") as AppConfig["logLevel"];

  return {
    role,
    instanceId: env.INSTANCE_ID ?? `${hostname()}-${process.pid}`,
    port: int(env, "PORT", 3000),
    logLevel,
    shutdownGraceMs: int(env, "SHUTDOWN_GRACE_MS", 20_000),
    database: {
      url: env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering",
      poolMin: int(env, "DB_POOL_MIN", 1),
      poolMax: int(env, "DB_POOL_MAX", 20),
      lockTimeoutMs: int(env, "DB_LOCK_TIMEOUT_MS", 5_000),
      statementTimeoutMs: int(env, "DB_STATEMENT_TIMEOUT_MS", 15_000),
    },
    // Local-first defaults (like DATABASE_URL): with nothing configured the
    // service talks to LocalStack on localhost:4566. In real AWS set
    // AWS_ENDPOINT_URL="" (empty) and let the SDK resolve credentials.
    aws: (() => {
      const endpoint = env.AWS_ENDPOINT_URL === undefined ? "http://localhost:4566" : env.AWS_ENDPOINT_URL || undefined;
      const local = endpoint !== undefined && /localhost|127\.0\.0\.1|localstack|ministack/.test(endpoint);
      return {
        region: env.AWS_REGION ?? "us-east-1",
        endpoint,
        accessKeyId: env.AWS_ACCESS_KEY_ID || (local ? "test" : undefined),
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY || (local ? "test" : undefined),
      };
    })(),
    sqs: {
      wagerQueueName: env.SQS_WAGER_QUEUE ?? "wager-transactions.fifo",
      deadLetterQueueName: env.SQS_WAGER_DLQ ?? "wager-transactions-dlq.fifo",
      eventsQueueName: env.SQS_EVENTS_QUEUE ?? "wagering-events.fifo",
      consumerName: env.SQS_CONSUMER_NAME ?? "wager-transactions-consumer",
      maxReceiveCount: int(env, "SQS_MAX_RECEIVE_COUNT", 5),
      waitTimeSeconds: int(env, "SQS_WAIT_TIME_SECONDS", 20),
      visibilityTimeoutSeconds: int(env, "SQS_VISIBILITY_TIMEOUT_SECONDS", 30),
      concurrency: Math.max(1, int(env, "SQS_CONSUMER_CONCURRENCY", 4)),
      retryBaseDelaySeconds: int(env, "SQS_RETRY_BASE_DELAY_SECONDS", 2),
      autoCreateQueues: bool(env, "SQS_AUTO_CREATE_QUEUES", true),
    },
    outbox: {
      pollIntervalMs: int(env, "OUTBOX_POLL_INTERVAL_MS", 500),
      batchSize: int(env, "OUTBOX_BATCH_SIZE", 100),
      leaseMs: int(env, "OUTBOX_LEASE_MS", 30_000),
    },
    pendingReference: {
      pollIntervalMs: int(env, "PENDING_REFERENCE_POLL_INTERVAL_MS", 1_000),
      batchSize: int(env, "PENDING_REFERENCE_BATCH_SIZE", 50),
      leaseMs: int(env, "PENDING_REFERENCE_LEASE_MS", 30_000),
      maxAttempts: int(env, "PENDING_REFERENCE_MAX_ATTEMPTS", 10),
      baseDelayMs: int(env, "PENDING_REFERENCE_BASE_DELAY_MS", 1_000),
      maxDelayMs: int(env, "PENDING_REFERENCE_MAX_DELAY_MS", 60_000),
    },
  };
}
