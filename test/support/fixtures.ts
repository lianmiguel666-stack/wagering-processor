import { randomUUID } from "node:crypto";
import { UnitOfWork } from "../../src/application/ports/repositories";
import { Clock, EventPublisher, Metrics, noopMetrics, silentLogger } from "../../src/application/ports/runtime";
import { UuidV7Generator } from "../../src/application/services/system";
import { DEFAULT_PENDING_REFERENCE_POLICY, PendingReferencePolicy, WagerProcessor } from "../../src/application/services/wager-processor";
import { CreateWalletUseCase } from "../../src/application/use-cases/create-wallet";
import { ExecutionContext, ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process-wager-transaction";
import { PublishOutboxUseCase } from "../../src/application/use-cases/publish-outbox";
import { WalletQueries } from "../../src/application/use-cases/queries";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet";
import { ResolvePendingReferencesUseCase } from "../../src/application/use-cases/resolve-pending-references";
import { parseSubmitWagerInput, SubmitWagerInput } from "../../src/application/use-cases/wager-command";
import { IntegrationEventEnvelope } from "../../src/domain/events/integration-event";
import { DEFAULT_OUTBOX_RETRY_POLICY } from "../../src/domain/messaging/outbox-message";
import { SqlUnitOfWork } from "../../src/infrastructure/persistence/sql-unit-of-work";
import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";

/** Clock whose time can be moved forward (pending-reference backoff tests). */
export class AdjustableClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

/** Counts calls so tests can assert on metrics. */
export class CountingMetrics implements Metrics {
  readonly counts = new Map<string, number>();
  private inc(key: string, by = 1) {
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }
  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
  transactionCompleted(status: string) { this.inc(`tx:${status}`); }
  duplicateDetected(kind: string) { this.inc(`dup:${kind}`); }
  retry(reason: string) { this.inc(`retry:${reason}`); }
  deadLettered(reason: string) { this.inc(`dlq:${reason}`); }
  lockConflict() { this.inc("lock_conflict"); }
  processingDuration() {}
  outboxPublished(n: number) { this.inc("outbox:published", n); }
  outboxState() {}
  reconciliationDivergence() { this.inc("reconciliation:divergence"); }
}

export interface TestApp {
  uow: UnitOfWork;
  clock: AdjustableClock;
  metrics: CountingMetrics;
  process: ProcessWagerTransactionUseCase;
  createWallet: CreateWalletUseCase;
  queries: WalletQueries;
  reconcile: ReconcileWalletUseCase;
  resolvePending: ResolvePendingReferencesUseCase;
  outboxRelay: (publisher: EventPublisher, owner: string) => PublishOutboxUseCase;
}

export function buildTestApp(
  runner: SqlTransactionRunner,
  policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
): TestApp {
  const clock = new AdjustableClock();
  const ids = new UuidV7Generator();
  const metrics = new CountingMetrics();
  const uow = new SqlUnitOfWork(runner, metrics);
  const processor = new WagerProcessor(clock, ids, policy);
  return {
    uow,
    clock,
    metrics,
    process: new ProcessWagerTransactionUseCase(uow, processor, clock, ids, metrics, silentLogger),
    createWallet: new CreateWalletUseCase(uow, clock, ids, silentLogger),
    queries: new WalletQueries(uow),
    reconcile: new ReconcileWalletUseCase(uow, metrics, silentLogger),
    resolvePending: new ResolvePendingReferencesUseCase(uow, processor, clock, metrics, silentLogger, {
      batchSize: 100,
      leaseMs: 5_000,
    }),
    outboxRelay: (publisher, owner) =>
      new PublishOutboxUseCase(uow, publisher, clock, noopMetrics, silentLogger, owner, {
        batchSize: 50,
        leaseMs: 2_000,
        retryPolicy: { ...DEFAULT_OUTBOX_RETRY_POLICY, baseDelayMs: 10, maxDelayMs: 50 },
      }),
  };
}

export async function openWallet(app: TestApp, amount: string, currency = "BRL") {
  return app.createWallet.execute({ playerId: randomUUID(), initialBalance: { amount, currency } }, "test");
}

export function wager(
  wallet: { id: string; playerId: string },
  overrides: Partial<SubmitWagerInput> & { externalTransactionId?: string } = {},
): SubmitWagerInput {
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `tx-${randomUUID()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: "provider-a",
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "10.00", currency: "BRL" },
    ...overrides,
  };
}

export const http = (): ExecutionContext => ({ source: "http", correlationId: randomUUID() });

export async function submit(app: TestApp, input: SubmitWagerInput, context: ExecutionContext = http()) {
  const outcome = await app.process.execute(parseSubmitWagerInput(input), context);
  if (outcome.type !== "result") throw new Error("unexpected duplicate-message outcome");
  return outcome.result;
}

/** Final invariant of every test: materialised balance == balance rebuilt from the ledger. */
export async function assertLedgerConsistent(app: TestApp, walletId: string): Promise<void> {
  const report = await app.reconcile.execute(walletId);
  if (!report.consistent) {
    throw new Error(`wallet ${walletId} inconsistent: ${JSON.stringify(report)}`);
  }
}

export class RecordingPublisher implements EventPublisher {
  readonly published: IntegrationEventEnvelope[] = [];
  failNext = 0;
  async publish(event: IntegrationEventEnvelope): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("broker unavailable");
    }
    this.published.push(event);
  }
}
