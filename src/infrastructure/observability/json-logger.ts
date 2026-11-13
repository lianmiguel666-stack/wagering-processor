import type { LoggerService } from "@nestjs/common";
import { AppLogger, LogFields } from "../../application/ports/runtime";
import { RequestContext } from "./request-context";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

/**
 * Keys that must never reach the logs: full payloads, monetary details,
 * credentials. Values are replaced, not dropped, so their presence is visible.
 */
const REDACTED_KEYS = new Set(["payload", "body", "data", "money", "balance", "authorization", "token", "password"]);

/**
 * Structured JSON logger (one line per event, stdout). Implements both the
 * application AppLogger port and Nest's LoggerService. Correlation fields
 * (correlationId, messageId, transactionId, walletId, providerId) come from
 * the async request context automatically.
 */
export class JsonLogger implements AppLogger, LoggerService {
  private readonly threshold: number;

  constructor(
    private readonly options: { level: Level; service: string; instanceId: string },
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {
    this.threshold = LEVELS[options.level];
  }

  debug(message: unknown, fields?: unknown): void {
    this.write("debug", message, fields);
  }
  info(message: unknown, fields?: unknown): void {
    this.write("info", message, fields);
  }
  warn(message: unknown, fields?: unknown): void {
    this.write("warn", message, fields);
  }
  error(message: unknown, fields?: unknown): void {
    this.write("error", message, fields);
  }
  // Nest LoggerService
  log(message: unknown, context?: unknown): void {
    this.write("info", message, context);
  }
  verbose(message: unknown, context?: unknown): void {
    this.write("debug", message, context);
  }
  fatal(message: unknown, context?: unknown): void {
    this.write("error", message, context);
  }

  private write(level: Level, message: unknown, extra: unknown): void {
    if (LEVELS[level] < this.threshold) return;
    const fields: LogFields =
      extra && typeof extra === "object" ? (extra as LogFields) : typeof extra === "string" ? { context: extra } : {};
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      service: this.options.service,
      instanceId: this.options.instanceId,
      msg: message instanceof Error ? message.message : String(message),
      ...RequestContext.current(),
    };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      line[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value;
    }
    this.sink(JSON.stringify(line));
  }
}
