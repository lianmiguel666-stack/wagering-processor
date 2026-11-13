import {
  ApplicationError,
  ConcurrencyConflictError,
  DuplicateExternalTransactionIdError,
  IdempotencyConflictError,
  ResourceNotFoundError,
  TransientInfrastructureError,
  UniqueViolationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from "../../../application/errors";
import { WagerResult } from "../../../application/use-cases/process-wager-transaction";
import { InvalidArgumentError } from "../../../domain/shared/domain-error";
import { RequestErrorCode } from "../../../domain/wagering/failure-code";
import { WagerTransactionStatus } from "../../../domain/wagering/wager-transaction";

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    field?: string;
    /** Whether re-sending the same request may succeed. */
    retryable: boolean;
  };
}

export interface MappedError {
  status: number;
  body: ErrorBody;
  retryAfterSeconds?: number;
}

/**
 * Single, consistent HTTP mapping for every endpoint:
 *
 *   400  VALIDATION_ERROR                    payload invalid → fix it, never retry as is
 *   404  NOT_FOUND                           resource in the URL path does not exist
 *   409  IDEMPOTENCY_KEY_CONFLICT,           key/identity reused with another payload
 *        DUPLICATE_EXTERNAL_TRANSACTION_ID,
 *        WALLET_ALREADY_EXISTS
 *   422  business rejection (failureCode)    terminal; replays return the same 422
 *        WALLET_NOT_FOUND (wallet referenced in a command body)
 *   202  accepted, PENDING_REFERENCE         poll GET …/transactions/:id
 *   201  processed (first time)  /  200  idempotent replay of a processed tx
 *   503  INFRASTRUCTURE_UNAVAILABLE          transient; retry with the SAME key (Retry-After)
 *   500  INTERNAL_ERROR                      bug; safe to retry with the same key
 */
export function mapError(error: unknown): MappedError {
  const body = (code: string, message: string, retryable: boolean, field?: string): ErrorBody => ({
    error: { code, message, retryable, ...(field ? { field } : {}) },
  });

  if (error instanceof InvalidArgumentError) {
    return { status: 400, body: body(RequestErrorCode.ValidationError, error.message, false, error.field) };
  }
  if (error instanceof ResourceNotFoundError) {
    return { status: 404, body: body(error.code, error.message, false) };
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof DuplicateExternalTransactionIdError ||
    error instanceof WalletAlreadyExistsError
  ) {
    return { status: 409, body: body(error.code, error.message, false) };
  }
  if (error instanceof WalletNotFoundError) {
    return { status: 422, body: body(error.code, error.message, false) };
  }
  if (error instanceof ApplicationError) {
    return { status: 422, body: body(error.code, error.message, false) };
  }
  if (
    error instanceof TransientInfrastructureError ||
    error instanceof ConcurrencyConflictError ||
    error instanceof UniqueViolationError
  ) {
    return {
      status: 503,
      body: body(RequestErrorCode.InfrastructureUnavailable, "temporarily unavailable, retry with the same Idempotency-Key", true),
      retryAfterSeconds: 1,
    };
  }
  return { status: 500, body: body(RequestErrorCode.InternalError, "internal error", true) };
}

export function statusForWagerResult(result: WagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}
