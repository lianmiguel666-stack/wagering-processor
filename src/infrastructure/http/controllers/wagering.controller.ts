import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ProcessWagerTransactionUseCase, WagerResult } from "../../../application/use-cases/process-wager-transaction";
import { TransactionView, WalletQueries } from "../../../application/use-cases/queries";
import { parseSubmitWagerInput } from "../../../application/use-cases/wager-command";
import { InvalidArgumentError } from "../../../domain/shared/domain-error";
import { RequestContext } from "../../observability/request-context";
import { TOKENS } from "../../tokens";
import { assertProviderAllowed, PRINCIPAL_KEY, ProviderAuthGuard, ProviderPrincipal } from "../auth/provider-auth.guard";
import { currentCorrelationId } from "../correlation.middleware";
import { statusForWagerResult } from "../filters/error-mapping";

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(TOKENS.ProcessWager) private readonly processWager: ProcessWagerTransactionUseCase,
    @Inject(TOKENS.Queries) private readonly queries: WalletQueries,
  ) {}

  /**
   * 201 processed · 200 idempotent replay · 202 PENDING_REFERENCE
   * 422 REJECTED (body carries failureCode) · 400 · 409 · 503 (see error-mapping.ts)
   */
  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { [PRINCIPAL_KEY]?: ProviderPrincipal },
    @Res({ passthrough: true }) res: Response,
  ): Promise<WagerResult> {
    if (!idempotencyKey) {
      throw new InvalidArgumentError("Idempotency-Key header is required", "idempotencyKey");
    }
    if (!body || typeof body !== "object") throw new InvalidArgumentError("body must be a JSON object");
    assertProviderAllowed(req[PRINCIPAL_KEY], body.providerId);

    const command = parseSubmitWagerInput({
      idempotencyKey,
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
    });
    RequestContext.set({ walletId: command.walletId, providerId: command.providerId });

    const outcome = await this.processWager.execute(command, {
      source: "http",
      correlationId: currentCorrelationId(),
    });
    if (outcome.type !== "result") {
      throw new Error("inbox outcome is impossible on the HTTP path");
    }
    RequestContext.set({ transactionId: outcome.result.transactionId });
    res.status(statusForWagerResult(outcome.result));
    return outcome.result;
  }

  @Get("wagering/transactions/:transactionId")
  getById(@Param("transactionId") transactionId: string): Promise<TransactionView> {
    return this.queries.getTransaction(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() req: Request & { [PRINCIPAL_KEY]?: ProviderPrincipal },
  ): Promise<TransactionView> {
    assertProviderAllowed(req[PRINCIPAL_KEY], providerId);
    return this.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
