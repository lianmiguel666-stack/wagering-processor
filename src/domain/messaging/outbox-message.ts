import { IntegrationEvent } from "../events/integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  lastError?: string;
}

export interface RetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_OUTBOX_RETRY_POLICY: RetryPolicy = { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 };

/** Exponential backoff: base · 2^(attempt-1), capped. Deterministic (no jitter) for testability. */
export function exponentialBackoffMs(attempt: number, policy: RetryPolicy): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.min(exponent, 30));
}

/**
 * Integration event waiting to be published. Its id *is* the eventId, so
 * consumers de-duplicate re-publications by eventId.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      Object.freeze({ ...state.payload }),
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (this._publishedAt) return; // idempotent
    this._publishedAt = at;
    this._attempts += 1;
    this._nextAttemptAt = undefined;
    this._lastError = undefined;
  }

  /** Increments attempts and computes the next nextAttemptAt (backoff). */
  scheduleRetry(now: Date, error?: string, policy: RetryPolicy = DEFAULT_OUTBOX_RETRY_POLICY): void {
    if (this._publishedAt) return;
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + exponentialBackoffMs(this._attempts, policy));
    this._lastError = error?.slice(0, 500);
  }
}
