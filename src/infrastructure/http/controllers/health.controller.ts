import { Controller, Get, Header, Inject, Optional, Res } from "@nestjs/common";
import type { Response } from "express";
import { SqsQueues } from "../../messaging/sqs/sqs-queues";
import { PrometheusMetrics } from "../../observability/prometheus-metrics";
import { SqlTransactionRunner } from "../../persistence/sql/sql-executor";
import { TOKENS } from "../../tokens";

async function probe(name: string, check: () => Promise<void>, timeoutMs = 2_000) {
  const started = performance.now();
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return { name, status: "up" as const, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { name, status: "down" as const, error: String(error) };
  }
}

/** Health endpoints are public (no auth guard). */
@Controller()
export class HealthController {
  constructor(
    @Inject(TOKENS.SqlRunner) private readonly db: SqlTransactionRunner,
    @Inject(TOKENS.SqsQueues) private readonly sqs: SqsQueues,
    @Optional() @Inject(TOKENS.Metrics) private readonly metrics?: PrometheusMetrics,
  ) {}

  /** Process is alive (no dependency checks: a DB outage must not restart pods). */
  @Get("health/live")
  live() {
    return { status: "ok" };
  }

  /** PostgreSQL and SQS reachable. 503 otherwise, so the instance stops receiving traffic. */
  @Get("health/ready")
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = await Promise.all([probe("postgres", () => this.db.ping()), probe("sqs", () => this.sqs.ping())]);
    const ok = checks.every((c) => c.status === "up");
    res.status(ok ? 200 : 503);
    return { status: ok ? "ok" : "unavailable", checks };
  }

  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  async metricsText(): Promise<string> {
    return this.metrics ? this.metrics.registry.metrics() : "";
  }
}
