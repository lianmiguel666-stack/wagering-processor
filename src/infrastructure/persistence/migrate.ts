/**
 * Migration CLI.
 *   bun run migrate:up      apply pending migrations
 *   bun run migrate:down    revert the last migration
 *   bun run migrate:status  list executed / pending migrations
 */
import { loadConfig } from "../config/app-config";
import { initOrm } from "./mikro-orm/mikro-orm";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "up";
  const orm = await initOrm(loadConfig());
  try {
    const migrator = orm.getMigrator();
    if (command === "up") {
      const applied = await migrator.up();
      console.log(JSON.stringify({ msg: "migrations applied", migrations: applied.map((m) => m.name) }));
    } else if (command === "down") {
      const reverted = await migrator.down();
      console.log(JSON.stringify({ msg: "migration reverted", migrations: reverted.map((m) => m.name) }));
    } else if (command === "status") {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(JSON.stringify({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }));
    } else {
      throw new Error(`unknown command ${command}`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ level: "error", msg: "migration failed", err: String(error) }));
  process.exit(1);
});
