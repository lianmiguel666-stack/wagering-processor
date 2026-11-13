import { IntegrationEventEnvelope } from "../../domain/events/integration-event";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** Time-ordered unique id (UUIDv7). */
  next(): string;
}

export type LogFields = Record<string, string | number | boolean | undefined | null>;

/** Structured logger port. Implementations add correlation context automatically. */
export interface AppLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields & { err?: string }): void;
}

export type ProcessingSource = "http" | "sqs" | "worker";

/** Metrics port (Prometheus adapter in infrastructure). */
export interface Metrics {
  transactionCompleted(status: string, kind: string, source: ProcessingSource): void;
  duplicateDetected(kind: "idempotency_replay" | "inbox" | "idempotency_conflict"): void;
  retry(reason: string): void;
  deadLettered(reason: string): void;
  lockConflict(): void;
  processingDuration(seconds: number, source: ProcessingSource): void;
  outboxPublished(count: number): void;
  outboxState(pending: number, lagSeconds: number): void;
  reconciliationDivergence(): void;
}

/** Destination for outbox events (SQS adapter in infrastructure). */
export interface EventPublisher {
  publish(event: IntegrationEventEnvelope): Promise<void>;
}

export const noopMetrics: Metrics = {
  transactionCompleted: () => {},
  duplicateDetected: () => {},
  retry: () => {},
  deadLettered: () => {},
  lockConflict: () => {},
  processingDuration: () => {},
  outboxPublished: () => {},
  outboxState: () => {},
  reconciliationDivergence: () => {},
};

export const silentLogger: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
