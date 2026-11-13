import { RequestErrorCode } from "../domain/wagering/failure-code";

/**
 * Application-level errors. They are request outcomes that do not become a
 * persisted transaction. Each one maps to exactly one HTTP status and one
 * queue disposition (see infrastructure/http/filters and the SQS consumer).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: RequestErrorCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Same Idempotency-Key, different payload → conflict, never a replay. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = RequestErrorCode.IdempotencyKeyConflict;

  constructor(
    readonly idempotencyKey: string,
    readonly existingTransactionId: string,
  ) {
    super(`idempotency key "${idempotencyKey}" was already used with a different payload`);
  }
}

/** (providerId, externalTransactionId) already exists under another idempotency key. */
export class DuplicateExternalTransactionIdError extends ApplicationError {
  readonly code = RequestErrorCode.DuplicateExternalTransactionId;

  constructor(
    readonly providerId: string,
    readonly externalTransactionId: string,
  ) {
    super(`transaction ${providerId}/${externalTransactionId} already exists with a different idempotency key`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = RequestErrorCode.WalletNotFound;

  constructor(readonly walletId: string) {
    super(`wallet ${walletId} not found`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = RequestErrorCode.WalletAlreadyExists;

  constructor(playerId: string, currency: string) {
    super(`player ${playerId} already has a ${currency} wallet`);
  }
}

export class ResourceNotFoundError extends ApplicationError {
  readonly code = RequestErrorCode.NotFound;

  constructor(resource: string, id: string) {
    super(`${resource} ${id} not found`);
  }
}

// ---------------------------------------------------------------------------
// Infrastructure signals understood by the application layer. Adapters
// translate driver-specific errors into these.
// ---------------------------------------------------------------------------

/** Temporary condition: connection loss, lock timeout, deadlock, broker down... Safe to retry. */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TransientInfrastructureError";
  }
}

/** A unique constraint fired. `constraint` is the DB constraint name. */
export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string,
    override readonly cause?: unknown,
  ) {
    super(`unique constraint violated: ${constraint}`);
    this.name = "UniqueViolationError";
  }
}

/** Compare-and-set failed (row version/status changed underneath us). */
export class ConcurrencyConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`concurrent modification of ${entity} ${id}`);
    this.name = "ConcurrencyConflictError";
  }
}
