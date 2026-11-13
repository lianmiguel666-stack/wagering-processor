import { SendMessageCommand } from "@aws-sdk/client-sqs";
import type { EventPublisher } from "../../../application/ports/runtime";
import type { IntegrationEventEnvelope } from "../../../domain/events/integration-event";
import { SqsQueues } from "./sqs-queues";

/**
 * Publishes outbox events to `wagering-events.fifo`.
 *  - MessageGroupId = aggregateId (walletId): per-wallet ordering for consumers;
 *  - MessageDeduplicationId = eventId: SQS drops re-publications inside its
 *    5-minute window. Outside it, consumers de-duplicate by eventId — broker
 *    dedup is an optimisation, never the guarantee.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly queues: SqsQueues) {}

  async publish(event: IntegrationEventEnvelope): Promise<void> {
    await this.queues.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queues.eventsQueueUrl(),
        MessageBody: JSON.stringify(event),
        MessageGroupId: event.aggregateId,
        MessageDeduplicationId: event.eventId,
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: event.eventType },
          eventVersion: { DataType: "Number", StringValue: String(event.version) },
          correlationId: { DataType: "String", StringValue: event.correlationId },
        },
      }),
    );
  }
}
