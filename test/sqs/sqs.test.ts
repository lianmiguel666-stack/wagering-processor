import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DeleteQueueCommand, Message, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { silentLogger } from "../../src/application/ports/runtime";
import { AppConfig, loadConfig } from "../../src/infrastructure/config/app-config";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs/sqs-event-publisher";
import { createSqsClient, SqsQueues } from "../../src/infrastructure/messaging/sqs/sqs-queues";
import { SqsWagerConsumer } from "../../src/infrastructure/messaging/sqs/sqs-wager-consumer";
import { WagerMessageHandler } from "../../src/infrastructure/messaging/wager-message-handler";
import { SqlTransactionRunner } from "../../src/infrastructure/persistence/sql/sql-executor";
import { createRunner, createUnreachableRunner, resetSchema } from "../support/database";
import { assertLedgerConsistent, buildTestApp, openWallet, TestApp, wager } from "../support/fixtures";

/**
 * End-to-end through a REAL SQS (LocalStack/MiniStack, `docker compose up -d localstack`)
 * and a REAL PostgreSQL. Queues get a unique prefix per run.
 */
const RUN = randomUUID().slice(0, 8);
let runner: SqlTransactionRunner;
let app: TestApp;
let config: AppConfig;
let queues: SqsQueues;

beforeAll(async () => {
  runner = await createRunner();
  await resetSchema(runner);
  app = buildTestApp(runner);
  config = loadConfig({
    ...process.env,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "test",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    SQS_WAGER_QUEUE: `t-${RUN}-wager.fifo`,
    SQS_WAGER_DLQ: `t-${RUN}-wager-dlq.fifo`,
    SQS_EVENTS_QUEUE: `t-${RUN}-events.fifo`,
    SQS_MAX_RECEIVE_COUNT: "2",
    SQS_WAIT_TIME_SECONDS: "1",
    SQS_VISIBILITY_TIMEOUT_SECONDS: "5",
    SQS_RETRY_BASE_DELAY_SECONDS: "1",
    SQS_CONSUMER_CONCURRENCY: "2",
    SHUTDOWN_GRACE_MS: "5000",
  });
  queues = new SqsQueues(createSqsClient(config), config);
  await queues.wagerQueueUrl();
  await queues.eventsQueueUrl();
});

afterAll(async () => {
  for (const url of [await queues.wagerQueueUrl(), await queues.deadLetterQueueUrl(), await queues.eventsQueueUrl()]) {
    await queues.client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
  }
  await runner.close();
});

async function send(data: object, messageId = `msg-${randomUUID()}`, dedup = randomUUID()) {
  await queues.client.send(
    new SendMessageCommand({
      QueueUrl: await queues.wagerQueueUrl(),
      MessageBody: JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data }),
      MessageGroupId: (data as { walletId?: string }).walletId ?? "g",
      MessageDeduplicationId: dedup,
    }),
  );
  return messageId;
}

async function receiveAll(queueUrl: string, waitMs = 3_000): Promise<Message[]> {
  const out: Message[] = [];
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const r = await queues.client.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ["All"] }));
    out.push(...(r.Messages ?? []));
  }
  return out;
}

async function until(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(200);
  }
  throw new Error("condition not met in time");
}

function consumer(handlerApp: TestApp = app) {
  const handler = new WagerMessageHandler(handlerApp.process, handlerApp.metrics, silentLogger, {
    consumerName: config.sqs.consumerName,
    maxReceiveCount: config.sqs.maxReceiveCount,
    retryBaseDelaySeconds: config.sqs.retryBaseDelaySeconds,
  });
  return new SqsWagerConsumer(queues, handler, config, silentLogger);
}

describe("SQS consumer (LocalStack)", () => {
  test("processes, acks after commit, and absorbs redelivery of the same messageId", async () => {
    const wallet = await openWallet(app, "100.00");
    const data = wager(wallet, { money: { amount: "10.00", currency: "BRL" } });
    const messageId = await send(data);
    await send(data, messageId); // broker-level duplicate with a new dedup id (same logical message)
    const c = consumer();
    c.start();
    await until(async () => (await app.queries.getWallet(wallet.id)).balance.amount === "90.00");
    await Bun.sleep(1_500);
    await c.stop();
    expect((await app.queries.getWallet(wallet.id)).balance.amount).toBe("90.00");
    expect(await receiveAll(await queues.wagerQueueUrl(), 1_500)).toHaveLength(0); // everything acked
    await assertLedgerConsistent(app, wallet.id);
  }, 30_000);

  test("permanent failures go to the DLQ with a reason", async () => {
    await queues.client.send(new PurgeQueueCommand({ QueueUrl: await queues.deadLetterQueueUrl() })).catch(() => {});
    await send({ kind: "OPENING" });
    const c = consumer();
    c.start();
    const dlq = await receiveAll(await queues.deadLetterQueueUrl(), 6_000);
    await c.stop();
    expect(dlq.length).toBeGreaterThanOrEqual(1);
    expect(dlq[0]?.MessageAttributes?.deadLetterReason?.StringValue).toBe("invalid_payload");
  }, 30_000);

  test("transient failures are retried with backoff and dead-lettered after maxReceiveCount", async () => {
    const deadRunner = await createUnreachableRunner();
    const deadApp = buildTestApp(deadRunner);
    await send(wager({ id: randomUUID(), playerId: randomUUID() }));
    const c = consumer(deadApp);
    c.start();
    const dlq = await receiveAll(await queues.deadLetterQueueUrl(), 12_000);
    await c.stop();
    await deadRunner.close().catch(() => {});
    expect(dlq.some((m) => m.MessageAttributes?.deadLetterReason?.StringValue?.startsWith("retries_exhausted"))).toBe(true);
  }, 40_000);

  test("outbox relay publishes committed events to the events queue (FIFO dedup by eventId)", async () => {
    const wallet = await openWallet(app, "5.00");
    const relay = app.outboxRelay(new SqsEventPublisher(queues), "sqs-relay");
    for (let i = 0; i < 20 && (await relay.runOnce()).claimed > 0; i++);
    const events = await receiveAll(await queues.eventsQueueUrl(), 3_000);
    const bodies = events.map((m) => JSON.parse(m.Body ?? "{}"));
    expect(bodies.some((b) => b.eventType === "WalletBalanceChanged" && b.aggregateId === wallet.id)).toBe(true);
  }, 30_000);
});
