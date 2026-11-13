import { IntegrationEventEnvelope } from "../../domain/events/integration-event";
import { RetryPolicy, DEFAULT_OUTBOX_RETRY_POLICY } from "../../domain/messaging/outbox-message";
import { UnitOfWork } from "../ports/repositories";
import { AppLogger, Clock, EventPublisher, Metrics } from "../ports/runtime";

export interface PublishOutboxOptions {
  batchSize: number;
  leaseMs: number;
  retryPolicy: RetryPolicy;
}

export interface PublishRunSummary {
  claimed: number;
  published: number;
  failed: number;
  lostLease: number;
}

/**
 * Outbox relay. Safe with many concurrent publishers:
 *
 *  1. claim: short transaction, `FOR UPDATE SKIP LOCKED`, sets
 *     locked_by/locked_until (lease) and commits — no lock is held while
 *     talking to the broker;
 *  2. publish each event;
 *  3. record the result only if we still own the lease.
 *
 * If the process dies between 2 and 3, the lease expires and another
 * instance publishes again → at-least-once. Consumers de-duplicate by
 * eventId (the outbox id), and SQS FIFO dedup (MessageDeduplicationId =
 * eventId) absorbs most duplicates inside its 5-minute window.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly owner: string,
    private readonly options: PublishOutboxOptions = {
      batchSize: 100,
      leaseMs: 30_000,
      retryPolicy: DEFAULT_OUTBOX_RETRY_POLICY,
    },
  ) {}

  async runOnce(): Promise<PublishRunSummary> {
    const summary: PublishRunSummary = { claimed: 0, published: 0, failed: 0, lostLease: 0 };
    const messages = await this.uow.transactional((repos) =>
      repos.outbox.claimDue(this.clock.now(), this.options.batchSize, this.options.leaseMs, this.owner),
    );
    summary.claimed = messages.length;

    for (const message of messages) {
      try {
        await this.publisher.publish(message.payload as unknown as IntegrationEventEnvelope);
        message.markPublished(this.clock.now());
        summary.published++;
      } catch (error) {
        message.scheduleRetry(this.clock.now(), String(error), this.options.retryPolicy);
        summary.failed++;
        this.metrics.retry("outbox_publish");
        this.logger.warn("outbox publish failed, retry scheduled", {
          eventId: message.id,
          eventType: message.eventType,
          attempts: message.attempts,
          err: String(error),
        });
      }
      const saved = await this.uow.transactional((repos) => repos.outbox.saveAttempt(message, this.owner));
      if (!saved) summary.lostLease++;
    }
    if (summary.published > 0) this.metrics.outboxPublished(summary.published);
    return summary;
  }

  async refreshLagMetric(): Promise<void> {
    const stats = await this.uow.transactional((repos) => repos.outbox.stats(this.clock.now()));
    this.metrics.outboxState(stats.pending, stats.oldestPendingAgeSeconds);
  }
}
