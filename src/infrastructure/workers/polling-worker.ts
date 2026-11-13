import { AppLogger } from "../../application/ports/runtime";

/**
 * Runs `task` every `intervalMs` until stopped. If a run reports work done
 * (returns true) the next run starts immediately, so backlogs drain fast.
 * Errors back off exponentially. `stop()` waits for the current run.
 */
export class PollingWorker {
  private running = false;
  private current: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<boolean>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
    this.logger.info("worker started", { worker: this.name, intervalMs: this.intervalMs });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.wake?.();
    await this.current;
    this.logger.info("worker stopped", { worker: this.name });
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      let busy = false;
      try {
        busy = await this.task();
        failures = 0;
      } catch (error) {
        failures++;
        this.logger.warn("worker run failed", { worker: this.name, failures, err: String(error) });
      }
      if (!this.running) break;
      const delay = failures > 0 ? Math.min(30_000, this.intervalMs * 2 ** Math.min(failures, 6)) : busy ? 0 : this.intervalMs;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, delay);
      });
    }
  }
}
