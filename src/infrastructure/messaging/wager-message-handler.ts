import { ApplicationError, ConcurrencyConflictError, TransientInfrastructureError, UniqueViolationError } from "../../application/errors";
import type { AppLogger, Metrics } from "../../application/ports/runtime";
import { hashCanonical } from "../../application/services/payload-hash";
import { ProcessWagerTransactionUseCase } from "../../application/use-cases/process-wager-transaction";
import { parseSubmitWagerInput, SubmitWagerInput } from "../../application/use-cases/wager-command";
import { InvalidArgumentError } from "../../domain/shared/domain-error";
import { RequestContext } from "../observability/request-context";

export const WAGER_MESSAGE_TYPE = "WagerTransactionRequested";

/** What the transport must do with the message. */
export type Disposition =
  | { action: "ack"; reason: string }
  | { action: "retry"; delaySeconds: number; reason: string }
  | { action: "dead-letter"; reason: string };

export interface HandlerOptions {
  consumerName: string;
  /** Deliveries allowed before dead-lettering a transient failure. */
  maxReceiveCount: number;
  retryBaseDelaySeconds: number;
}

/** Max visibility extension allowed by SQS is 12h; we cap backoff at 15 min. */
const MAX_DELAY_SECONDS = 900;

interface Envelope {
  messageId: string;
  type: string;
  occurredAt?: string;
  correlationId?: string;
  data: SubmitWagerInput;
}

function parseEnvelope(body: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidArgumentError("message body is not valid JSON");
  }
  const e = parsed as Partial<Envelope> | null;
  if (!e || typeof e !== "object") throw new InvalidArgumentError("message body must be an object");
  if (typeof e.messageId !== "string" || e.messageId.length === 0 || e.messageId.length > 255) {
    throw new InvalidArgumentError("messageId is required", "messageId");
  }
  if (e.type !== WAGER_MESSAGE_TYPE) throw new InvalidArgumentError(`type must be ${WAGER_MESSAGE_TYPE}`, "type");
  if (!e.data || typeof e.data !== "object") throw new InvalidArgumentError("data is required", "data");
  return e as Envelope;
}

/**
 * Transport-agnostic consumer logic. Reuses the very same use case as HTTP
 * and classifies every outcome:
 *
 *   success / duplicate / business rejection  → ack (terminal)
 *   invalid message (permanent)               → dead-letter immediately
 *   transient infrastructure error            → retry with backoff, then DLQ
 *                                               after maxReceiveCount deliveries
 *   unexpected error                          → treated as transient (bounded)
 */
export class WagerMessageHandler {
  constructor(
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly options: HandlerOptions,
  ) {}

  async handle(body: string, receiveCount: number): Promise<Disposition> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(body);
    } catch (error) {
      return this.deadLetter("invalid_envelope", error);
    }

    const correlationId = envelope.correlationId ?? envelope.messageId;
    return RequestContext.run({ correlationId, messageId: envelope.messageId }, async () => {
      let command;
      try {
        command = parseSubmitWagerInput(envelope.data);
      } catch (error) {
        return this.deadLetter("invalid_payload", error);
      }
      RequestContext.set({ walletId: command.walletId, providerId: command.providerId });

      try {
        const outcome = await this.useCase.execute(command, {
          source: "sqs",
          correlationId,
          causationId: envelope.messageId,
          inbox: {
            consumerName: this.options.consumerName,
            messageId: envelope.messageId,
            payloadHash: hashCanonical(envelope.data),
          },
        });
        if (outcome.type === "duplicate-message") return { action: "ack", reason: "duplicate_message" };
        RequestContext.set({ transactionId: outcome.result.transactionId });
        return { action: "ack", reason: outcome.result.status.toLowerCase() };
      } catch (error) {
        return this.classify(error, receiveCount);
      }
    });
  }

  private classify(error: unknown, receiveCount: number): Disposition {
    if (error instanceof ApplicationError) {
      // Business-level refusal (idempotency conflict, unknown wallet...):
      // re-delivering will never change the answer.
      this.logger.warn("message rejected by business rule", { code: error.code, err: error.message });
      return { action: "ack", reason: error.code.toLowerCase() };
    }
    if (error instanceof InvalidArgumentError) {
      return this.deadLetter("invalid_payload", error);
    }
    const transient =
      error instanceof TransientInfrastructureError ||
      error instanceof ConcurrencyConflictError ||
      error instanceof UniqueViolationError;
    const reason = transient
      ? error instanceof TransientInfrastructureError
        ? error.reason
        : "database_race"
      : "unexpected_error";

    if (receiveCount >= this.options.maxReceiveCount) {
      return this.deadLetter(`retries_exhausted:${reason}`, error);
    }
    const delaySeconds = Math.min(MAX_DELAY_SECONDS, this.options.retryBaseDelaySeconds * 2 ** Math.max(0, receiveCount - 1));
    this.metrics.retry(`sqs_${reason}`);
    this.logger.warn("message processing failed, will retry", {
      reason,
      receiveCount,
      delaySeconds,
      err: String(error),
    });
    return { action: "retry", delaySeconds, reason };
  }

  private deadLetter(reason: string, error: unknown): Disposition {
    this.metrics.deadLettered(reason.split(":")[0] as string);
    this.logger.error("message dead-lettered", { reason, err: String(error) });
    return { action: "dead-letter", reason };
  }
}
