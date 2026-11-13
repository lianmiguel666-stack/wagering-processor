import { AsyncLocalStorage } from "node:async_hooks";

/** Correlation fields propagated through async calls and added to every log line. */
export interface RequestContextFields {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContextFields>();

export const RequestContext = {
  run<T>(fields: RequestContextFields, fn: () => T): T {
    return storage.run({ ...fields }, fn);
  },
  current(): RequestContextFields | undefined {
    return storage.getStore();
  },
  /** Enriches the current context in place (e.g. once walletId is known). */
  set(fields: Partial<RequestContextFields>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
};
