import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { AppLogger } from "../../../application/ports/runtime";
import { AppConfig } from "../../config/app-config";
import { Disposition, WagerMessageHandler } from "../wager-message-handler";
import { SqsQueues } from "./sqs-queues";

/**
 * Long-polling consumer for `wager-transactions.fifo`.
 *
 *  - ack (DeleteMessage) happens only after the use case returned, i.e. after
 *    COMMIT. A crash in between causes a redelivery that the inbox absorbs.
 *  - retry = ChangeMessageVisibility(backoff); the message comes back later
 *    with ApproximateReceiveCount + 1.
 *  - dead-letter = copy to the DLQ with the reason, then delete. The queue's
 *    RedrivePolicy is a safety net for crash loops.
 *  - SIGTERM: stop polling, give back (visibility 0) every received message
 *    not yet started, wait for in-flight ones up to the grace period.
 *
 * Messages of one receive batch are processed sequentially to respect FIFO
 * group order; parallelism comes from `concurrency` independent pollers
 * (SQS FIFO hands different message groups to different pollers).
 */
export class SqsWagerConsumer {
  private running = false;
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly queues: SqsQueues,
    private readonly handler: WagerMessageHandler,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = Array.from({ length: this.config.sqs.concurrency }, (_, i) => this.loop(i));
    this.logger.info("sqs consumer started", { concurrency: this.config.sqs.concurrency });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    const grace = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), this.config.shutdownGraceMs));
    const result = await Promise.race([Promise.all([...this.loops, ...this.inFlight]).then(() => "done" as const), grace]);
    this.logger.info("sqs consumer stopped", { result, inFlight: this.inFlight.size });
  }

  private async loop(index: number): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        const queueUrl = await this.queues.wagerQueueUrl();
        const response = await this.queues.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.config.sqs.waitTimeSeconds,
            VisibilityTimeout: this.config.sqs.visibilityTimeoutSeconds,
            // New + legacy parameter: older LocalStack/MiniStack builds only honour AttributeNames.
            MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
            AttributeNames: ["All"],
          }),
          { abortSignal: this.abort.signal },
        );
        failures = 0;
        const messages = response.Messages ?? [];
        for (let i = 0; i < messages.length; i++) {
          const message = messages[i] as Message;
          if (!this.running) {
            await this.release(queueUrl, messages.slice(i));
            break;
          }
          const work = this.process(queueUrl, message);
          this.inFlight.add(work);
          try {
            await work;
          } finally {
            this.inFlight.delete(work);
          }
        }
      } catch (error) {
        if (!this.running) break;
        failures++;
        const delay = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
        this.logger.warn("sqs receive failed", { poller: index, failures, delayMs: delay, err: String(error) });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async process(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
    let disposition: Disposition;
    try {
      disposition = await this.handler.handle(message.Body ?? "", receiveCount);
    } catch (error) {
      // Handler never throws by contract; be defensive and let visibility expire.
      this.logger.error("unexpected handler failure", { err: String(error) });
      return;
    }
    try {
      await this.apply(queueUrl, message, disposition);
    } catch (error) {
      // Could not ack/retry: the message reappears after the visibility
      // timeout and the inbox makes the reprocessing harmless.
      this.logger.warn("failed to apply message disposition", { action: disposition.action, err: String(error) });
    }
  }

  private async apply(queueUrl: string, message: Message, disposition: Disposition): Promise<void> {
    const receipt = message.ReceiptHandle as string;
    switch (disposition.action) {
      case "ack":
        await this.queues.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
        return;
      case "retry":
        await this.queues.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: receipt,
            VisibilityTimeout: disposition.delaySeconds,
          }),
        );
        return;
      case "dead-letter":
        await this.queues.client.send(
          new SendMessageCommand({
            QueueUrl: await this.queues.deadLetterQueueUrl(),
            MessageBody: message.Body ?? "",
            MessageGroupId: message.Attributes?.MessageGroupId ?? "dead-letter",
            MessageDeduplicationId: message.MessageId,
            MessageAttributes: {
              deadLetterReason: { DataType: "String", StringValue: disposition.reason },
              receiveCount: { DataType: "Number", StringValue: message.Attributes?.ApproximateReceiveCount ?? "1" },
            },
          }),
        );
        await this.queues.client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receipt }));
        return;
    }
  }

  /** Gives messages back to the queue immediately (used on shutdown). */
  private async release(queueUrl: string, messages: Message[]): Promise<void> {
    await Promise.allSettled(
      messages.map((m) =>
        this.queues.client.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }),
        ),
      ),
    );
  }
}
