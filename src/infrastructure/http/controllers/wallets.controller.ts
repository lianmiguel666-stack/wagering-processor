import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { type CreateWalletInput, CreateWalletUseCase, type WalletView } from "../../../application/use-cases/create-wallet";
import { type LedgerPageView, WalletQueries } from "../../../application/use-cases/queries";
import { ReconcileWalletUseCase, type ReconciliationReport } from "../../../application/use-cases/reconcile-wallet";
import { TOKENS } from "../../tokens";
import { ProviderAuthGuard } from "../auth/provider-auth.guard";
import { currentCorrelationId } from "../correlation.middleware";

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(TOKENS.CreateWallet) private readonly createWallet: CreateWalletUseCase,
    @Inject(TOKENS.Queries) private readonly queries: WalletQueries,
    @Inject(TOKENS.Reconcile) private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  /** 201 created · 400 invalid · 409 WALLET_ALREADY_EXISTS */
  @Post()
  @HttpCode(201)
  create(@Body() body: CreateWalletInput): Promise<WalletView> {
    return this.createWallet.execute(body, currentCorrelationId());
  }

  @Get(":walletId")
  get(@Param("walletId") walletId: string): Promise<WalletView> {
    return this.queries.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<LedgerPageView> {
    return this.queries.getLedger(walletId, cursor || undefined, limit);
  }

  /** Always 200; `consistent: false` signals a divergence (never auto-corrected). */
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  reconciliation(@Param("walletId") walletId: string): Promise<ReconciliationReport> {
    return this.reconcile.execute(walletId);
  }
}
