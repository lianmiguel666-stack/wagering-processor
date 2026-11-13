import { Money } from "../money/money";
import { InvalidArgumentError, InvalidTransactionStateError } from "../shared/domain-error";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: wallet opening credit
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // accepted, not yet applied
  PendingReference = "PENDING_REFERENCE", // waiting for the referenced transaction
  Processed = "PROCESSED", // applied (terminal)
  Rejected = "REJECTED", // business rule violation (terminal)
  Failed = "FAILED", // permanent infrastructure error (terminal, auditable)
}

/** Reserved provider id for internal transactions; providers can never use it. */
export const OPENING_PROVIDER_ID = "internal";

/** Kinds a provider may submit (OPENING is internal only). */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Which kinds each kind may reference. */
export const ALLOWED_REFERENCE_KINDS: Readonly<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Opening]: [],
  [WagerTransactionKind.Bet]: [],
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * Valid transitions. Terminal states have no outgoing edge.
 *
 *   PENDING ──────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (retry bookkeeping)
 */
const TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Wallet balance observed when the transaction reached its current state. */
  resultBalance?: Money;
  referenceAttempts: number;
  nextRetryAt?: Date;
  updatedAt: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextRetryAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Born PENDING. Validates the reference requirement per kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertNonEmpty(props.providerId, "providerId");
    WagerTransaction.assertNonEmpty(props.externalTransactionId, "externalTransactionId");
    WagerTransaction.assertNonEmpty(props.idempotencyKey, "idempotencyKey");
    WagerTransaction.assertNonEmpty(props.roundId, "roundId");
    WagerTransaction.assertNonEmpty(props.gameId, "gameId");

    const requiresReference =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new InvalidArgumentError(`${props.kind} requires referenceExternalTransactionId`, "referenceExternalTransactionId");
    }
    if (ALLOWED_REFERENCE_KINDS[props.kind].length === 0 && props.referenceExternalTransactionId) {
      throw new InvalidArgumentError(`${props.kind} cannot reference another transaction`, "referenceExternalTransactionId");
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidArgumentError("a transaction cannot reference itself", "referenceExternalTransactionId");
    }
    if (props.money.isNegative()) {
      throw new InvalidArgumentError("money cannot be negative", "money.amount");
    }
    // LOSS records an outcome and may carry 0.00; every balance-moving kind
    // must carry a positive amount (a zero-amount ledger line is meaningless).
    if (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive()) {
      throw new InvalidArgumentError(`${props.kind} amount must be greater than zero`, "money.amount");
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.createdAt,
    );
  }

  /**
   * Internal OPENING credit created together with a wallet. It is born
   * PROCESSED because it is applied in the same SQL transaction that creates
   * the wallet; it can never be submitted through the API or the queue.
   */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    correlationId?: string;
    at: Date;
  }): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidArgumentError("OPENING amount must be greater than zero", "initialBalance");
    }
    return new WagerTransaction(
      props.id,
      OPENING_PROVIDER_ID,
      `opening:${props.walletId}`,
      `${OPENING_PROVIDER_ID}:opening:${props.walletId}`,
      props.payloadHash,
      props.walletId,
      props.playerId,
      "opening",
      "internal",
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.correlationId,
      props.at,
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      props.at,
      props.money,
      0,
      undefined,
      props.at,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultBalance,
      state.referenceAttempts,
      state.nextRetryAt,
      state.updatedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transitions (throw InvalidTransactionStateError when current state is terminal)

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._failureCode = undefined;
    this._processedAt = at;
    this._resultBalance = resultBalance;
    this._nextRetryAt = undefined;
    this._updatedAt = at;
  }

  /**
   * Parks the transaction until its reference shows up. Each call counts one
   * resolution attempt and schedules the next one.
   */
  markPendingReference(nextRetryAt: Date, at: Date, observedBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._referenceAttempts += 1;
    this._nextRetryAt = nextRetryAt;
    this._resultBalance = observedBalance;
    this._updatedAt = at;
  }

  reject(code: FailureCode, at: Date, observedBalance: Money | undefined, referenceTransactionId?: string): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._resultBalance = observedBalance;
    this._referenceTransactionId = referenceTransactionId ?? this._referenceTransactionId;
    this._nextRetryAt = undefined;
    this._updatedAt = at;
  }

  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextRetryAt = undefined;
    this._updatedAt = at;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TRANSITIONS[this._status].length === 0;
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  canReference(reference: WagerTransaction): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind].includes(reference.kind);
  }

  /**
   * Direction of the ledger movement this transaction produces.
   * ROLLBACK inverts the direction of the transaction it reverts.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidArgumentError("ROLLBACK direction requires the referenced transaction", "reference");
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidArgumentError("LOSS does not produce a ledger movement", "kind");
    }
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }

  private static assertNonEmpty(value: string, field: string): void {
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 128) {
      throw new InvalidArgumentError(`${field} must be a non-empty string up to 128 characters`, field);
    }
  }
}
