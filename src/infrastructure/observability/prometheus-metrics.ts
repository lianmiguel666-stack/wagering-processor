import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Metrics, ProcessingSource } from "../../application/ports/runtime";

/** Prometheus adapter for the Metrics port. Exposed at GET /metrics. */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Wager transactions by final status, kind and entry point",
    labelNames: ["status", "kind", "source"],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Duplicates detected (idempotent replays, inbox hits, idempotency conflicts)",
    labelNames: ["kind"],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: "wagering_retries_total",
    help: "Retries by reason (db races, transient errors, outbox publish, SQS redelivery)",
    labelNames: ["reason"],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: "wagering_sqs_dead_lettered_total",
    help: "Messages moved to the DLQ by reason",
    labelNames: ["reason"],
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Wallet lock waits that hit lock_timeout",
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: "wagering_processing_duration_seconds",
    help: "End-to-end processing latency of a wager transaction",
    labelNames: ["source"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly outboxPublishedTotal = new Counter({
    name: "wagering_outbox_published_total",
    help: "Outbox events published",
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: "wagering_outbox_pending",
    help: "Unpublished outbox events",
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: "wagering_outbox_lag_seconds",
    help: "Age of the oldest unpublished outbox event",
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: "wagering_reconciliation_divergences_total",
    help: "Reconciliations where stored balance != ledger balance",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  transactionCompleted(status: string, kind: string, source: ProcessingSource): void {
    this.transactions.inc({ status, kind, source });
  }
  duplicateDetected(kind: string): void {
    this.duplicates.inc({ kind });
  }
  retry(reason: string): void {
    this.retries.inc({ reason });
  }
  deadLettered(reason: string): void {
    this.dlq.inc({ reason });
  }
  lockConflict(): void {
    this.lockConflicts.inc();
  }
  processingDuration(seconds: number, source: ProcessingSource): void {
    this.latency.observe({ source }, seconds);
  }
  outboxPublished(count: number): void {
    this.outboxPublishedTotal.inc(count);
  }
  outboxState(pending: number, lagSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(lagSeconds);
  }
  reconciliationDivergence(): void {
    this.divergences.inc();
  }
}
