import { type DynamicModule, Inject, Injectable, type MiddlewareConsumer, Module, type NestModule, type OnApplicationShutdown, type Provider } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import type { UnitOfWork } from "../application/ports/repositories";
import type { AppLogger, Clock, IdGenerator, Metrics } from "../application/ports/runtime";
import { systemClock, UuidV7Generator } from "../application/services/system";
import { WagerProcessor } from "../application/services/wager-processor";
import { CreateWalletUseCase } from "../application/use-cases/create-wallet";
import { ProcessWagerTransactionUseCase } from "../application/use-cases/process-wager-transaction";
import { PublishOutboxUseCase } from "../application/use-cases/publish-outbox";
import { WalletQueries } from "../application/use-cases/queries";
import { ReconcileWalletUseCase } from "../application/use-cases/reconcile-wallet";
import { ResolvePendingReferencesUseCase } from "../application/use-cases/resolve-pending-references";
import { DEFAULT_OUTBOX_RETRY_POLICY } from "../domain/messaging/outbox-message";
import type { AppConfig } from "./config/app-config";
import { NoopProviderIdentity, ProviderAuthGuard } from "./http/auth/provider-auth.guard";
import { HealthController } from "./http/controllers/health.controller";
import { WageringController } from "./http/controllers/wagering.controller";
import { WalletsController } from "./http/controllers/wallets.controller";
import { correlationMiddleware } from "./http/correlation.middleware";
import { AllExceptionsFilter } from "./http/filters/all-exceptions.filter";
import { SqsEventPublisher } from "./messaging/sqs/sqs-event-publisher";
import { createSqsClient, SqsQueues } from "./messaging/sqs/sqs-queues";
import { SqsWagerConsumer } from "./messaging/sqs/sqs-wager-consumer";
import { WagerMessageHandler } from "./messaging/wager-message-handler";
import { JsonLogger } from "./observability/json-logger";
import { PrometheusMetrics } from "./observability/prometheus-metrics";
import { initOrm, MikroOrmTransactionRunner } from "./persistence/mikro-orm/mikro-orm";
import { SqlUnitOfWork } from "./persistence/sql-unit-of-work";
import type { SqlTransactionRunner } from "./persistence/sql/sql-executor";
import { TOKENS } from "./tokens";
import { BackgroundWorkers, SQS_CONSUMER } from "./workers/background-workers";

/** Closes the connection pool after every other shutdown hook ran. */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(TOKENS.SqlRunner) private readonly runner: SqlTransactionRunner) {}

  async onApplicationShutdown(): Promise<void> {
    await this.runner.close();
  }
}

/** Composition root: wires ports to adapters. Domain/application never import Nest. */
@Module({})
export class AppModule implements NestModule {
  static forRoot(config: AppConfig, logger: JsonLogger): DynamicModule {
    const core: Provider[] = [
      { provide: TOKENS.Config, useValue: config },
      { provide: TOKENS.Logger, useValue: logger },
      { provide: TOKENS.Metrics, useValue: new PrometheusMetrics() },
      { provide: TOKENS.Clock, useValue: systemClock },
      { provide: TOKENS.Ids, useValue: new UuidV7Generator() },
      { provide: TOKENS.ProviderIdentity, useClass: NoopProviderIdentity },
      {
        provide: TOKENS.SqlRunner,
        useFactory: async () =>
          new MikroOrmTransactionRunner(await initOrm(config), {
            lockTimeoutMs: config.database.lockTimeoutMs,
            statementTimeoutMs: config.database.statementTimeoutMs,
          }),
      },
      {
        provide: TOKENS.UnitOfWork,
        inject: [TOKENS.SqlRunner, TOKENS.Metrics],
        useFactory: (runner: SqlTransactionRunner, metrics: Metrics) => new SqlUnitOfWork(runner, metrics),
      },
      {
        provide: TOKENS.WagerProcessor,
        inject: [TOKENS.Clock, TOKENS.Ids],
        useFactory: (clock: Clock, ids: IdGenerator) =>
          new WagerProcessor(clock, ids, {
            maxAttempts: config.pendingReference.maxAttempts,
            baseDelayMs: config.pendingReference.baseDelayMs,
            maxDelayMs: config.pendingReference.maxDelayMs,
          }),
      },
      {
        provide: TOKENS.ProcessWager,
        inject: [TOKENS.UnitOfWork, TOKENS.WagerProcessor, TOKENS.Clock, TOKENS.Ids, TOKENS.Metrics, TOKENS.Logger],
        useFactory: (uow: UnitOfWork, p: WagerProcessor, clock: Clock, ids: IdGenerator, m: Metrics, l: AppLogger) =>
          new ProcessWagerTransactionUseCase(uow, p, clock, ids, m, l),
      },
      {
        provide: TOKENS.CreateWallet,
        inject: [TOKENS.UnitOfWork, TOKENS.Clock, TOKENS.Ids, TOKENS.Logger],
        useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, l: AppLogger) =>
          new CreateWalletUseCase(uow, clock, ids, l),
      },
      {
        provide: TOKENS.Queries,
        inject: [TOKENS.UnitOfWork],
        useFactory: (uow: UnitOfWork) => new WalletQueries(uow),
      },
      {
        provide: TOKENS.Reconcile,
        inject: [TOKENS.UnitOfWork, TOKENS.Metrics, TOKENS.Logger],
        useFactory: (uow: UnitOfWork, m: Metrics, l: AppLogger) => new ReconcileWalletUseCase(uow, m, l),
      },
      { provide: TOKENS.SqsQueues, useFactory: () => new SqsQueues(createSqsClient(config), config) },
      DatabaseLifecycle,
      ProviderAuthGuard,
      { provide: APP_FILTER, useClass: AllExceptionsFilter },
    ];

    const workers: Provider[] = [
      {
        provide: TOKENS.ResolvePending,
        inject: [TOKENS.UnitOfWork, TOKENS.WagerProcessor, TOKENS.Clock, TOKENS.Metrics, TOKENS.Logger],
        useFactory: (uow: UnitOfWork, p: WagerProcessor, clock: Clock, m: Metrics, l: AppLogger) =>
          new ResolvePendingReferencesUseCase(uow, p, clock, m, l, {
            batchSize: config.pendingReference.batchSize,
            leaseMs: config.pendingReference.leaseMs,
          }),
      },
      {
        provide: TOKENS.PublishOutbox,
        inject: [TOKENS.UnitOfWork, TOKENS.SqsQueues, TOKENS.Clock, TOKENS.Metrics, TOKENS.Logger],
        useFactory: (uow: UnitOfWork, queues: SqsQueues, clock: Clock, m: Metrics, l: AppLogger) =>
          new PublishOutboxUseCase(uow, new SqsEventPublisher(queues), clock, m, l, config.instanceId, {
            batchSize: config.outbox.batchSize,
            leaseMs: config.outbox.leaseMs,
            retryPolicy: DEFAULT_OUTBOX_RETRY_POLICY,
          }),
      },
      {
        provide: SQS_CONSUMER,
        inject: [TOKENS.SqsQueues, TOKENS.ProcessWager, TOKENS.Metrics, TOKENS.Logger],
        useFactory: (queues: SqsQueues, useCase: ProcessWagerTransactionUseCase, m: Metrics, l: AppLogger) =>
          new SqsWagerConsumer(
            queues,
            new WagerMessageHandler(useCase, m, l, {
              consumerName: config.sqs.consumerName,
              maxReceiveCount: config.sqs.maxReceiveCount,
              retryBaseDelaySeconds: config.sqs.retryBaseDelaySeconds,
            }),
            config,
            l,
          ),
      },
      BackgroundWorkers,
    ];

    const servesApi = config.role === "api" || config.role === "all";
    const runsWorkers = config.role === "worker" || config.role === "all";

    return {
      module: AppModule,
      controllers: [HealthController, ...(servesApi ? [WalletsController, WageringController] : [])],
      providers: [...core, ...(runsWorkers ? workers : [])],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes("*");
  }
}
