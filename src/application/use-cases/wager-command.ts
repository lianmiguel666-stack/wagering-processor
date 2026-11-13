import { Money, MoneyProps } from "../../domain/money/money";
import { InvalidArgumentError } from "../../domain/shared/domain-error";
import {
  ALLOWED_REFERENCE_KINDS,
  OPENING_PROVIDER_ID,
  SUBMITTABLE_KINDS,
  WagerTransactionKind,
} from "../../domain/wagering/wager-transaction";
import { hashCanonical } from "../services/payload-hash";

/** Raw input, as received from HTTP (body + header) or SQS (message.data). */
export interface SubmitWagerInput {
  idempotencyKey: unknown;
  providerId: unknown;
  externalTransactionId: unknown;
  playerId: unknown;
  walletId: unknown;
  roundId: unknown;
  gameId: unknown;
  kind: unknown;
  money: unknown;
  referenceExternalTransactionId?: unknown;
}

/** Validated command. */
export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  payloadHash: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9._:\-]{1,128}$/;

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new InvalidArgumentError(`${field} must match ${IDENTIFIER.source}`, field);
  }
  return value;
}

export function requiredUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new InvalidArgumentError(`${field} must be a UUID`, field);
  }
  return value.toLowerCase();
}

/**
 * Validates raw input into a command and computes the payload hash.
 *
 * payloadHash = sha256_hex(canonicalJson({
 *   providerId, externalTransactionId, playerId, walletId, roundId, gameId,
 *   kind, money: { amount, currency }, referenceExternalTransactionId?
 * }))
 *
 * - keys sorted recursively, no whitespace, absent optional fields omitted;
 * - `money.amount` is hashed in its *normalised* form ("25" ≡ "25.00");
 * - the Idempotency-Key and transport metadata (messageId, occurredAt,
 *   headers, correlation id) are NOT part of the hash.
 */
export function parseSubmitWagerInput(input: SubmitWagerInput): SubmitWagerCommand {
  if (input === null || typeof input !== "object") {
    throw new InvalidArgumentError("body must be an object");
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 255) {
    throw new InvalidArgumentError("Idempotency-Key is required (1..255 chars)", "idempotencyKey");
  }
  const providerId = requiredIdentifier(input.providerId, "providerId");
  if (providerId === OPENING_PROVIDER_ID) {
    throw new InvalidArgumentError(`providerId "${OPENING_PROVIDER_ID}" is reserved`, "providerId");
  }
  if (typeof input.kind !== "string" || !(SUBMITTABLE_KINDS as readonly string[]).includes(input.kind)) {
    throw new InvalidArgumentError(`kind must be one of ${SUBMITTABLE_KINDS.join(", ")}`, "kind");
  }
  const reference =
    input.referenceExternalTransactionId === undefined || input.referenceExternalTransactionId === null
      ? undefined
      : requiredIdentifier(input.referenceExternalTransactionId, "referenceExternalTransactionId");

  const kind = input.kind as WagerTransactionKind;
  if (ALLOWED_REFERENCE_KINDS[kind].length === 0 && reference !== undefined) {
    throw new InvalidArgumentError(`${kind} cannot carry referenceExternalTransactionId`, "referenceExternalTransactionId");
  }
  if ((kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback) && reference === undefined) {
    throw new InvalidArgumentError(`${kind} requires referenceExternalTransactionId`, "referenceExternalTransactionId");
  }

  const command: Omit<SubmitWagerCommand, "payloadHash"> = {
    idempotencyKey: input.idempotencyKey,
    providerId,
    externalTransactionId: requiredIdentifier(input.externalTransactionId, "externalTransactionId"),
    playerId: requiredUuid(input.playerId, "playerId"),
    walletId: requiredUuid(input.walletId, "walletId"),
    roundId: requiredIdentifier(input.roundId, "roundId"),
    gameId: requiredIdentifier(input.gameId, "gameId"),
    kind,
    money: Money.from(input.money as MoneyProps),
    referenceExternalTransactionId: reference,
  };
  return { ...command, payloadHash: computeWagerPayloadHash(command) };
}

export function computeWagerPayloadHash(command: Omit<SubmitWagerCommand, "payloadHash" | "idempotencyKey">): string {
  return hashCanonical({
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    playerId: command.playerId,
    walletId: command.walletId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money.toJSON(),
    referenceExternalTransactionId: command.referenceExternalTransactionId,
  });
}
