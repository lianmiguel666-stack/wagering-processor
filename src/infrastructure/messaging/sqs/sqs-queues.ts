import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueuesCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { TransientInfrastructureError } from "../../../application/errors";
import { AppConfig } from "../../config/app-config";

export function createSqsClient(config: AppConfig): SQSClient {
  return new SQSClient({
    region: config.aws.region,
    endpoint: config.aws.endpoint,
    credentials:
      config.aws.accessKeyId && config.aws.secretAccessKey
        ? { accessKeyId: config.aws.accessKeyId, secretAccessKey: config.aws.secretAccessKey }
        : undefined,
    maxAttempts: 3,
  });
}

/** Errors on which talking to SQS again later is reasonable. */
export function isTransientSqsError(error: unknown): boolean {
  const e = error as { name?: string; $retryable?: unknown; $metadata?: { httpStatusCode?: number }; code?: string };
  if (e?.$retryable) return true;
  const status = e?.$metadata?.httpStatusCode;
  if (status !== undefined && (status >= 500 || status === 429)) return true;
  return ["TimeoutError", "NetworkingError", "ECONNREFUSED", "ECONNRESET", "ThrottlingException", "RequestThrottled"].includes(
    e?.name ?? e?.code ?? "",
  );
}

/**
 * Resolves (and optionally provisions) queue URLs lazily and caches them, so
 * the process starts even while SQS is temporarily unavailable; the consumer
 * and the outbox relay simply retry until it is back.
 */
export class SqsQueues {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(
    readonly client: SQSClient,
    private readonly config: AppConfig,
  ) {}

  wagerQueueUrl(): Promise<string> {
    return this.resolve(this.config.sqs.wagerQueueName, async () => {
      const dlqUrl = await this.deadLetterQueueUrl();
      const attrs = await this.client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }));
      return {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: String(this.config.sqs.visibilityTimeoutSeconds),
        // Safety net for poison messages that crash the process before the
        // consumer can dead-letter them explicitly.
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: attrs.Attributes?.QueueArn,
          maxReceiveCount: this.config.sqs.maxReceiveCount + 1,
        }),
      };
    });
  }

  deadLetterQueueUrl(): Promise<string> {
    return this.resolve(this.config.sqs.deadLetterQueueName, async () => ({
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      MessageRetentionPeriod: "1209600",
    }));
  }

  eventsQueueUrl(): Promise<string> {
    return this.resolve(this.config.sqs.eventsQueueName, async () => ({
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
    }));
  }

  /** Readiness probe. */
  async ping(): Promise<void> {
    await this.client.send(new ListQueuesCommand({ MaxResults: 1 }));
  }

  private resolve(name: string, attributes: () => Promise<Record<string, string>>): Promise<string> {
    let url = this.urls.get(name);
    if (!url) {
      url = this.lookup(name, attributes).catch((error) => {
        this.urls.delete(name); // do not cache failures
        throw isTransientSqsError(error)
          ? new TransientInfrastructureError(`sqs unavailable resolving ${name}`, "sqs_unavailable", error)
          : error;
      });
      this.urls.set(name, url);
    }
    return url;
  }

  private async lookup(name: string, attributes: () => Promise<Record<string, string>>): Promise<string> {
    if (this.config.sqs.autoCreateQueues) {
      try {
        const created = await this.client.send(new CreateQueueCommand({ QueueName: name, Attributes: await attributes() }));
        if (created.QueueUrl) return created.QueueUrl;
      } catch (error) {
        const code = (error as { name?: string }).name;
        if (code !== "QueueAlreadyExists" && code !== "QueueNameExists") throw error;
      }
    }
    const found = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!found.QueueUrl) throw new Error(`queue ${name} not found`);
    return found.QueueUrl;
  }
}
