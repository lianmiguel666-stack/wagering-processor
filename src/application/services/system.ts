import { randomBytes } from "node:crypto";
import { Clock, IdGenerator } from "../ports/runtime";

export const systemClock: Clock = { now: () => new Date() };

/**
 * UUIDv7 (RFC 9562): 48-bit unix ms timestamp + random. Time-ordered ids keep
 * B-tree inserts append-mostly and make ids roughly sortable by creation.
 */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    const bytes = randomBytes(16);
    const ts = BigInt(Date.now());
    for (let i = 0; i < 6; i++) {
      bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
    }
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant 10
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
