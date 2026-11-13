import { Wallet } from "../wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import { WagerTransaction, WagerTransactionStatus } from "./wager-transaction";

export interface SettlementInput {
  transaction: WagerTransaction;
  /** Must be the wallet referenced by `transaction`, loaded under lock. */
  wallet: Wallet;
  /**
   * Resolved reference. `undefined` when the transaction carries no
   * reference; `null` when it carries one that could not be found.
   */
  reference: WagerTransaction | null | undefined;
  /** Whether the reference already has a PROCESSED REFUND/ROLLBACK. */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  at: Date;
}

export type SettlementOutcome =
  | { readonly type: "processed"; readonly ledgerEntry?: WalletLedgerEntry }
  | { readonly type: "rejected"; readonly failureCode: FailureCode }
  | { readonly type: "awaiting-reference" };

/**
 * Pure domain service: decides what a transaction does to a wallet.
 *
 * It mutates the wallet (via debit/credit) and moves the transaction to
 * PROCESSED or REJECTED. It never transitions to PENDING_REFERENCE itself —
 * it returns `awaiting-reference` and lets the caller apply the retry policy
 * (backoff / attempt limit), which is an application concern.
 */
export class WagerSettlement {
  static settle(input: SettlementInput): SettlementOutcome {
    const { transaction: tx, wallet, reference, at } = input;

    if (tx.money.currency !== wallet.currency) {
      return WagerSettlement.reject(input, FailureCode.CurrencyMismatch);
    }
    if (tx.playerId !== wallet.playerId) {
      return WagerSettlement.reject(input, FailureCode.PlayerWalletMismatch);
    }

    if (tx.hasReference()) {
      if (!reference) {
        return { type: "awaiting-reference" };
      }
      if (
        reference.status === WagerTransactionStatus.Pending ||
        reference.status === WagerTransactionStatus.PendingReference
      ) {
        // The reference exists but is itself not applied yet.
        return { type: "awaiting-reference" };
      }
      const referenceFailure = WagerSettlement.validateReference(tx, reference, input.referenceAlreadyReversed);
      if (referenceFailure) {
        return WagerSettlement.reject(input, referenceFailure, reference.id);
      }
    }

    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, at, wallet.balance);
      return { type: "processed" };
    }

    const direction = tx.ledgerDirectionFor(reference ?? undefined);
    const movement = { entryId: input.ledgerEntryId, transactionId: tx.id, money: tx.money, at };

    let ledgerEntry: WalletLedgerEntry;
    if (direction === LedgerDirection.Debit) {
      if (!wallet.canDebit(tx.money)) {
        const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
        return WagerSettlement.reject(input, code, reference?.id);
      }
      ledgerEntry = wallet.debit(movement);
    } else {
      ledgerEntry = wallet.credit(movement);
    }

    tx.markProcessed(reference?.id, at, wallet.balance);
    return { type: "processed", ledgerEntry };
  }

  private static validateReference(
    tx: WagerTransaction,
    reference: WagerTransaction,
    alreadyReversed: boolean,
  ): FailureCode | undefined {
    if (
      reference.providerId !== tx.providerId ||
      reference.walletId !== tx.walletId ||
      reference.playerId !== tx.playerId ||
      reference.money.currency !== tx.money.currency ||
      reference.roundId !== tx.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (!tx.canReference(reference)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (tx.isReversal()) {
      if (!reference.money.equals(tx.money)) {
        return FailureCode.ReferenceAmountMismatch;
      }
      if (alreadyReversed) {
        return FailureCode.ReferenceAlreadyReversed;
      }
    }
    return undefined;
  }

  private static reject(input: SettlementInput, code: FailureCode, referenceId?: string): SettlementOutcome {
    input.transaction.reject(code, input.at, input.wallet.balance, referenceId);
    return { type: "rejected", failureCode: code };
  }
}
