/**
 * One "application instance" for the multi-process test: its own process,
 * its own connection pool, the same use cases. Prints a JSON summary.
 */
import { randomUUID } from "node:crypto";
import { createRunner } from "./database";
import { buildTestApp, submit, wager } from "./fixtures";

const spec = JSON.parse(process.env.SPEC ?? "{}") as {
  wallets: Array<{ id: string; playerId: string }>;
  shared: Parameters<typeof submit>[1];
  opsPerWallet: number;
};

const runner = await createRunner({ max: 10, lockTimeoutMs: 30_000 });
const app = buildTestApp(runner);
try {
  const work: Array<Promise<unknown>> = [];
  const shared = submit(app, spec.shared);
  for (const wallet of spec.wallets) {
    for (let i = 0; i < spec.opsPerWallet; i++) {
      const kind = i % 3 === 0 ? "WIN" : "BET";
      work.push(
        submit(app, wager(wallet, { kind, externalTransactionId: `p${process.env.INSTANCE}-${randomUUID()}`, money: { amount: "9.99", currency: "BRL" } })),
      );
    }
  }
  const results = (await Promise.all(work)) as Array<{ status: string }>;
  process.stdout.write(
    JSON.stringify({
      shared: await shared,
      processed: results.filter((r) => r.status === "PROCESSED").length,
      rejected: results.filter((r) => r.status === "REJECTED").length,
    }),
  );
} finally {
  await runner.close();
}
