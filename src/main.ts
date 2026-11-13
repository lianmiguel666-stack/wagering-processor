import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./infrastructure/app.module";
import { loadConfig } from "./infrastructure/config/app-config";
import { JsonLogger } from "./infrastructure/observability/json-logger";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new JsonLogger({ level: config.logLevel, service: "wagering-processor", instanceId: config.instanceId });

  const app = await NestFactory.create(AppModule.forRoot(config, logger), { logger, bufferLogs: false });
  // SIGTERM/SIGINT → beforeApplicationShutdown (stop consumer & workers,
  // drain in-flight work) → onApplicationShutdown (close DB pool).
  app.enableShutdownHooks();
  await app.listen(config.port, "0.0.0.0");
  logger.info("service started", { role: config.role, port: config.port });
}

bootstrap().catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: "error", msg: "bootstrap failed", err: String(error) })}\n`);
  process.exit(1);
});
