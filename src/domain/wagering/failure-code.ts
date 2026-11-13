/**
 * Stable, machine-readable failure taxonomy.
 *
 * Every code carries a `category` that tells the provider what to do:
 *  - `business`  — terminal rejection. Re-sending the same payload yields the
 *                  same answer (idempotent replay). Do not retry.
 *  - `reference` — terminal rejection caused by the referenced transaction.
 *                  The provider may need to fix data on its side.
 *  - `infrastructure` — terminal FAILED after exhausting internal retries.
 *                  Escalate / reconcile; the transaction is auditable.
 *
 * Request-level errors that never become a persisted transaction
 * (validation, idempotency conflicts, transient unavailability) live in
 * {@link RequestErrorCode}.
 */
export enum FailureCode {
  // ---- business (balance / ownership)
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** A REFUND/ROLLBACK would drive the balance negative. Distinct on purpose. */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",

  // ---- reference resolution
  /** Pending-reference retries exhausted: the referenced transaction never arrived. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Reference belongs to another player / wallet / currency / round. */
  ReferenceMismatch = "REFERENCE_MISMATCH",
  /** e.g. REFUND referencing a WIN, ROLLBACK referencing a ROLLBACK. */
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED",
  /** Reference exists but was REJECTED/FAILED, so there is nothing to revert. */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  /** Partial reversals are out of scope: amount must equal the reference. */
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",

  // ---- infrastructure (terminal FAILED)
  ProcessingFailed = "PROCESSING_FAILED",
}

export type FailureCategory = "business" | "reference" | "infrastructure";

export const FAILURE_CATEGORY: Readonly<Record<FailureCode, FailureCategory>> = {
  [FailureCode.InsufficientFunds]: "business",
  [FailureCode.ReversalInsufficientFunds]: "business",
  [FailureCode.CurrencyMismatch]: "business",
  [FailureCode.PlayerWalletMismatch]: "business",
  [FailureCode.ReferenceNotFound]: "reference",
  [FailureCode.ReferenceMismatch]: "reference",
  [FailureCode.ReferenceKindNotAllowed]: "reference",
  [FailureCode.ReferenceNotProcessed]: "reference",
  [FailureCode.ReferenceAlreadyReversed]: "reference",
  [FailureCode.ReferenceAmountMismatch]: "reference",
  [FailureCode.ProcessingFailed]: "infrastructure",
};

export function isFailureCode(value: unknown): value is FailureCode {
  return typeof value === "string" && (Object.values(FailureCode) as string[]).includes(value);
}

/** Errors answered to the caller that do not produce a persisted transaction. */
export enum RequestErrorCode {
  ValidationError = "VALIDATION_ERROR",
  IdempotencyKeyConflict = "IDEMPOTENCY_KEY_CONFLICT",
  DuplicateExternalTransactionId = "DUPLICATE_EXTERNAL_TRANSACTION_ID",
  WalletNotFound = "WALLET_NOT_FOUND",
  WalletAlreadyExists = "WALLET_ALREADY_EXISTS",
  NotFound = "NOT_FOUND",
  Unauthorized = "UNAUTHORIZED",
  InfrastructureUnavailable = "INFRASTRUCTURE_UNAVAILABLE",
  InternalError = "INTERNAL_ERROR",
}
