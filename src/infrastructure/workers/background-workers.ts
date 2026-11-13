import { BeforeApplicationShutdown, Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { AppLogger } from "../../application/ports/runtime";
import { PublishOutboxUseCase } from "../../application/use-cases/publish-outbox";
import { ResolvePendingReferencesUseCase } from "../../application/use-cases/resolve-pending-references";
import { AppConfig } from "../config/app-config";
import { SqsWagerConsumer } from "../messaging/sqs/sqs-wager-consumer";
import { TOKENS } from "../tokens";
import { PollingWorker } from "./polling-worker";

export const SQS_CONSUMER = Symbol("SqsWagerConsumer");

/**
 * Starts the asynchronous side of the service on worker instances:
 * SQS consumer, outbox relay, pending-reference resolver and the outbox lag
 * gauge. All of them are safe to run on N instances concurrently.
 * On SIGTERM they stop before the database pool closes.
 */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly workers: PollingWorker[];

  constructor(
    @Inject(TOKENS.Config) config: AppConfig,
    @Inject(TOKENS.Logger) private readonly logger: AppLogger,
    @Inject(SQS_CONSUMER) private readonly consumer: SqsWagerConsumer,
    @Inject(TOKENS.PublishOutbox) outbox: PublishOutboxUseCase,
    @Inject(TOKENS.ResolvePending) pending: ResolvePendingReferencesUseCase,
  ) {
    this.workers = [
      new PollingWorker(
        "outbox-relay",
        config.outbox.pollIntervalMs,
        async () => (await outbox.runOnce()).claimed > 0,
        logger,
      ),
      new PollingWorker("outbox-lag", 5_000, async () => (await outbox.refreshLagMetric(), false), logger),
      new PollingWorker(
        "pending-references",
        config.pendingReference.pollIntervalMs,
        async () => (await pending.runOnce()).claimed > 0,
        logger,
      ),
    ];
  }

  onApplicationBootstrap(): void {
    this.consumer.start();
    for (const worker of this.workers) worker.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info("shutting down background workers", { signal });
    // Stop taking new messages first, then let the relays finish their batch.
    await this.consumer.stop();
    await Promise.all(this.workers.map((w) => w.stop()));
  }
}
