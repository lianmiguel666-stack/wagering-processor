/**
 * Sends a WagerTransactionRequested message to the queue (manual testing).
 *
 *   bun run send:message -- --wallet <walletId> --player <playerId> --kind BET --amount 25.00 [--ref <externalId>] [--times 3]
 *
 * --times > 1 re-sends the SAME messageId (simulates broker redelivery).
 */
import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/infrastructure/config/app-config";
import { createSqsClient, SqsQueues } from "../src/infrastructure/messaging/sqs/sqs-queues";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

const config = loadConfig();
const queues = new SqsQueues(createSqsClient(config), config);
const externalTransactionId = arg("external", `tx-${randomUUID()}`);
const providerId = arg("provider", "provider-a");
const messageId = arg("message-id", `msg-${randomUUID()}`);
const reference = process.argv.includes("--ref") ? arg("ref") : undefined;
const data = {
  providerId,
  externalTransactionId,
  idempotencyKey: `${providerId}:${externalTransactionId}`,
  playerId: arg("player"),
  walletId: arg("wallet"),
  roundId: arg("round", "round-1"),
  gameId: arg("game", "fortune-chimp"),
  kind: arg("kind", "BET"),
  money: { amount: arg("amount", "10.00"), currency: arg("currency", "BRL") },
  ...(reference ? { referenceExternalTransactionId: reference } : {}),
};

const times = Number(arg("times", "1"));
for (let i = 0; i < times; i++) {
  await queues.client.send(
    new SendMessageCommand({
      QueueUrl: await queues.wagerQueueUrl(),
      MessageBody: JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data }),
      MessageGroupId: data.walletId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}
console.log(JSON.stringify({ sent: times, messageId, externalTransactionId }));
