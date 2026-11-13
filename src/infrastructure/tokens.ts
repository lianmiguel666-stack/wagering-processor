/** Nest DI tokens (ports are interfaces, so they need explicit tokens). */
export const TOKENS = {
  Config: Symbol("AppConfig"),
  Logger: Symbol("AppLogger"),
  Metrics: Symbol("Metrics"),
  SqlRunner: Symbol("SqlTransactionRunner"),
  UnitOfWork: Symbol("UnitOfWork"),
  Clock: Symbol("Clock"),
  Ids: Symbol("IdGenerator"),
  WagerProcessor: Symbol("WagerProcessor"),
  ProcessWager: Symbol("ProcessWagerTransactionUseCase"),
  CreateWallet: Symbol("CreateWalletUseCase"),
  Queries: Symbol("WalletQueries"),
  Reconcile: Symbol("ReconcileWalletUseCase"),
  ResolvePending: Symbol("ResolvePendingReferencesUseCase"),
  PublishOutbox: Symbol("PublishOutboxUseCase"),
  SqsQueues: Symbol("SqsQueues"),
  ProviderIdentity: Symbol("ProviderIdentityPort"),
} as const;
