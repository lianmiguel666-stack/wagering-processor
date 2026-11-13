/**
 * Simulates a consumer that commits the financial transaction and is killed
 * (SIGKILL) before it can acknowledge the message to the broker.
 */
import { parseSubmitWagerInput } from "../../src/application/use-cases/wager-command";
import { createRunner } from "./database";
import { buildTestApp } from "./fixtures";

const runner = await createRunner({ max: 2 });
const app = buildTestApp(runner);
const command = parseSubmitWagerInput(JSON.parse(process.env.COMMAND as string));
const inbox = JSON.parse(process.env.INBOX as string);
await app.process.execute(command, { source: "sqs", correlationId: "crash", inbox });
// Committed. Die before "ack".
process.kill(process.pid, "SIGKILL");
