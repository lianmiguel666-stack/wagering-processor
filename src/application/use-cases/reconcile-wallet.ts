import { MoneyProps } from "../../domain/money/money";
import { ResourceNotFoundError } from "../errors";
import { UnitOfWork } from "../ports/repositories";
import { AppLogger, Metrics } from "../ports/runtime";
import { requiredUuid } from "./wager-command";

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** Extra diagnostics: chain head of the ledger vs. wallet version. */
  ledgerHeadConsistent: boolean;
}

/**
 * Compares the materialised balance with the balance rebuilt from the
 * ledger. Divergences are never corrected silently: they are logged at
 * error level, counted in a metric and flagged in the response.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletIdInput: string): Promise<ReconciliationReport> {
    const walletId = requiredUuid(walletIdInput, "walletId");
    const snapshot = await this.uow.transactional((repos) => repos.ledger.reconcile(walletId));
    if (!snapshot) throw new ResourceNotFoundError("wallet", walletId);

    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const headConsistent =
      snapshot.checkedEntries === 0
        ? snapshot.storedBalance.isZero()
        : snapshot.lastBalanceAfter !== undefined &&
          snapshot.lastBalanceAfter.equals(snapshot.storedBalance) &&
          snapshot.lastWalletVersion === snapshot.walletVersion;
    const consistent = difference.isZero() && headConsistent;

    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.logger.error("wallet reconciliation divergence", {
        walletId,
        difference: difference.toString(),
        checkedEntries: snapshot.checkedEntries,
        ledgerHeadConsistent: headConsistent,
      });
    }

    return {
      walletId,
      storedBalance: snapshot.storedBalance.toJSON(),
      calculatedBalance: snapshot.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: snapshot.checkedEntries,
      ledgerHeadConsistent: headConsistent,
    };
  }
}
