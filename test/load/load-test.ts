/**
 * Load test — `bun run test:load`
 *
 * Drives the REAL HTTP API (BASE_URL) with N concurrent clients for a fixed
 * duration, then checks that every wallet still reconciles. It is a closed
 * model: each client sends its next request as soon as the previous answer
 * arrives, so throughput = how much the system sustains at that concurrency.
 *
 * Mix per request: 70% BET 10.00 · 25% WIN 5.00 · 5% LOSS 0.00. A share of
 * requests targets ONE hot wallet (lock contention), and a share re-sends an
 * already-sent request (idempotent replay).
 *
 * Measured: throughput, latency p50/p95/p99/max, status breakdown, error
 * rate, replays, lock conflicts and DB-race retries (from /metrics), outbox
 * lag and backlog (sampled from PostgreSQL), outbox drain time, and the final
 * reconciliation of every wallet.
 *
 * Env: BASE_URL (http://localhost:3000), DATABASE_URL
 *      (postgres://wagering:wagering@localhost:5432/wagering), DURATION_S (30),
 *      CONCURRENCY (50), WALLETS (200), HOT_SHARE (0.2), DUPLICATE_SHARE (0.05),
 *      REPORT_FILE (load-test-report.md)
 */
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { cpus, totalmem, platform, release } from "node:os";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://wagering:wagering@localhost:5432/wagering";
const DURATION_S = Number(process.env.DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const WALLETS = Number(process.env.WALLETS ?? 200);
const HOT_SHARE = Number(process.env.HOT_SHARE ?? 0.2);
const DUPLICATE_SHARE = Number(process.env.DUPLICATE_SHARE ?? 0.05);
const REPORT_FILE = process.env.REPORT_FILE ?? "load-test-report.md";

interface Wallet {
  id: string;
  playerId: string;
}

interface SentRequest {
  key: string;
  body: string;
}

type Outcome = "processed" | "replay" | "pending" | "rejected" | "conflict" | "transient" | "error";

const latencies: number[] = [];
const outcomes: Record<Outcome, number> = {
  processed: 0,
  replay: 0,
  pending: 0,
  rejected: 0,
  conflict: 0,
  transient: 0,
  error: 0,
};
const statusCodes = new Map<string, number>();
const sent: SentRequest[] = [];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

async function metricsSnapshot(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const text = await (await fetch(`${BASE_URL}/metrics`)).text();
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eE]+|NaN)$/.exec(line);
      if (!match) continue;
      const value = Number(match[3]);
      if (Number.isFinite(value)) out.set(match[1] as string, (out.get(match[1] as string) ?? 0) + value);
    }
  } catch {
    // metrics are best-effort
  }
  return out;
}

async function createWallet(): Promise<Wallet> {
  const playerId = randomUUID();
  const res = await fetch(`${BASE_URL}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: "1000.00", currency: "BRL" } }),
  });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return { id: body.id, playerId };
}

function classify(status: number, body: string): Outcome {
  if (status === 201) return "processed";
  if (status === 200) return body.includes('"idempotentReplay":true') ? "replay" : "processed";
  if (status === 202) return "pending";
  if (status === 422) return "rejected";
  if (status === 409) return "conflict";
  if (status === 503) return "transient";
  return "error";
}

async function send(request: SentRequest): Promise<void> {
  const started = performance.now();
  let status = 0;
  let body = "";
  try {
    const res = await fetch(`${BASE_URL}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": request.key },
      body: request.body,
    });
    status = res.status;
    body = await res.text();
  } catch {
    status = 0;
  }
  latencies.push(performance.now() - started);
  const outcome = status === 0 ? "error" : classify(status, body);
  outcomes[outcome]++;
  statusCodes.set(String(status || "network"), (statusCodes.get(String(status || "network")) ?? 0) + 1);
}

function nextRequest(wallets: Wallet[], hot: Wallet, client: number, seq: number): SentRequest {
  if (sent.length > 0 && Math.random() < DUPLICATE_SHARE) {
    return sent[Math.floor(Math.random() * sent.length)] as SentRequest;
  }
  const wallet = Math.random() < HOT_SHARE ? hot : (wallets[Math.floor(Math.random() * wallets.length)] as Wallet);
  const roll = Math.random();
  const [kind, amount] = roll < 0.7 ? ["BET", "10.00"] : roll < 0.95 ? ["WIN", "5.00"] : ["LOSS", "0.00"];
  const externalTransactionId = `load-${client}-${seq}-${randomUUID().slice(0, 8)}`;
  const request = {
    key: `load-provider:${externalTransactionId}`,
    body: JSON.stringify({
      providerId: "load-provider",
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${seq % 50}`,
      gameId: "load-game",
      kind,
      money: { amount, currency: "BRL" },
    }),
  };
  if (sent.length < 5_000) sent.push(request);
  return request;
}

async function main(): Promise<void> {
  const ready = await fetch(`${BASE_URL}/health/ready`).catch(() => undefined);
  if (!ready || ready.status !== 200) {
    throw new Error(`service not ready at ${BASE_URL} (start it with docker compose up -d or bun run start)`);
  }
  const db = new SQL({ url: DATABASE_URL, max: 2 });

  console.log(`creating ${WALLETS} wallets…`);
  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLETS; i += 20) {
    wallets.push(...(await Promise.all(Array.from({ length: Math.min(20, WALLETS - i) }, createWallet))));
  }
  const hot = wallets[0] as Wallet;

  const before = await metricsSnapshot();
  let maxLag = 0;
  let maxPending = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [row] = await db`SELECT COUNT(*)::int AS pending,
                                    COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))), 0)::float AS lag
                               FROM outbox_messages WHERE published_at IS NULL`;
      maxPending = Math.max(maxPending, Number(row.pending));
      maxLag = Math.max(maxLag, Number(row.lag));
      await Bun.sleep(500);
    }
  })();

  console.log(`running ${CONCURRENCY} concurrent clients for ${DURATION_S}s against ${BASE_URL}…`);
  const started = performance.now();
  const deadline = started + DURATION_S * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, client) => {
      for (let seq = 0; performance.now() < deadline; seq++) {
        await send(nextRequest(wallets, hot, client, seq));
      }
    }),
  );
  const elapsedS = (performance.now() - started) / 1000;

  // Outbox drain (requires workers running).
  const drainStarted = performance.now();
  let drained = false;
  for (let i = 0; i < 120; i++) {
    const [row] = await db`SELECT COUNT(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`;
    if (Number(row.pending) === 0) {
      drained = true;
      break;
    }
    await Bun.sleep(500);
  }
  const drainS = (performance.now() - drainStarted) / 1000;
  sampling = false;
  await sampler;

  // Final invariant: every wallet reconciles.
  let inconsistent = 0;
  for (let i = 0; i < wallets.length; i += 20) {
    const reports = await Promise.all(
      wallets.slice(i, i + 20).map(async (w) => {
        const res = await fetch(`${BASE_URL}/wallets/${w.id}/reconciliation`, { method: "POST" });
        return (await res.json()) as { consistent: boolean };
      }),
    );
    inconsistent += reports.filter((r) => !r.consistent).length;
  }
  const [negative] = await db`SELECT COUNT(*)::int AS n FROM wallets WHERE balance < 0`;
  await db.close();

  const after = await metricsSnapshot();
  const delta = (name: string) => (after.get(name) ?? 0) - (before.get(name) ?? 0);

  const sorted = [...latencies].sort((a, b) => a - b);
  const total = latencies.length;
  const errors = outcomes.error + outcomes.transient;
  const fmt = (n: number) => n.toFixed(1);
  const cpu = cpus()[0];

  const report = `# Load test report

Generated by \`bun run test:load\` on ${new Date().toISOString()}.

## Environment

| | |
|---|---|
| Target | ${BASE_URL} |
| Host | ${platform()} ${release()} · ${cpus().length}× ${cpu?.model ?? "?"} · ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM |
| Runtime | Bun ${Bun.version} |
| Load generator | same host as the service (results include client overhead) |

## Methodology

Closed model: ${CONCURRENCY} concurrent clients for ${DURATION_S}s, each sending the next request as soon as
the previous one answers. ${WALLETS} wallets (1000.00 BRL each); ${(HOT_SHARE * 100).toFixed(0)}% of requests hit
ONE hot wallet; ${(DUPLICATE_SHARE * 100).toFixed(0)}% re-send an already-sent request (idempotent replay).
Mix: 70% BET 10.00, 25% WIN 5.00, 5% LOSS. Outbox backlog sampled from PostgreSQL every 500 ms.

## Results

| Metric | Value |
|---|---|
| Requests | ${total} in ${fmt(elapsedS)}s |
| Throughput | **${fmt(total / elapsedS)} req/s** |
| Latency p50 / p95 / p99 / max | ${fmt(percentile(sorted, 50))} / ${fmt(percentile(sorted, 95))} / ${fmt(percentile(sorted, 99))} / ${fmt(sorted[sorted.length - 1] ?? 0)} ms |
| Error rate (5xx + network + 503) | **${((errors / Math.max(1, total)) * 100).toFixed(2)}%** (${errors}) |
| Processed (201) | ${outcomes.processed} |
| Idempotent replays (200) | ${outcomes.replay} |
| Business rejections (422, e.g. insufficient funds on the hot wallet) | ${outcomes.rejected} |
| Conflicts (409) | ${outcomes.conflict} |
| Pending reference (202) | ${outcomes.pending} |
| Lock conflicts (lock_timeout) | ${delta("wagering_lock_conflicts_total")} |
| DB-race retries (unique/CAS, internal) | ${delta("wagering_retries_total")} |
| Outbox max backlog / max lag | ${maxPending} events / ${fmt(maxLag)} s |
| Outbox drain after load | ${drained ? `${fmt(drainS)} s` : "not drained in 60 s (are workers running?)"} |
| Wallets inconsistent after test | **${inconsistent} / ${wallets.length}** |
| Wallets with negative balance | **${Number(negative.n)}** |

Status codes: ${[...statusCodes.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}

## Reading the numbers

- Correctness is the pass criterion: inconsistent wallets and negative balances must be 0.
- Hot-wallet requests serialise on one row lock by design; their latency dominates p99.
- 422 responses are expected business outcomes (the hot wallet runs out of funds), not errors.
`;

  await Bun.write(REPORT_FILE, report);
  console.log(report);
  console.log(`report written to ${REPORT_FILE}`);
  if (inconsistent > 0 || Number(negative.n) > 0) process.exit(1);
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
