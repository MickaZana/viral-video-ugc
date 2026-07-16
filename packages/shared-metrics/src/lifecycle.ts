import type { Server } from "node:http";

export interface LifecycleLogger {
  error(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface LifecycleOptions {
  /** How long to wait for in-flight requests to finish before forcing exit. Default 10s. */
  shutdownTimeoutMs?: number;
  /** Injectable for tests — defaults to the real process.exit. */
  exit?: (code: number) => void;
}

/**
 * Installs process-level crash visibility and graceful shutdown for a long-running
 * Express server. Without this, two failure modes were previously invisible/unhandled:
 *
 * 1. An unhandled promise rejection or uncaught exception crashes the process with only
 *    Node's default stderr dump — no structured log entry, easy to lose in a container
 *    log pipeline, and no record of *why* the process died before `restart: unless-stopped`
 *    silently brings up a fresh one.
 * 2. A SIGTERM (container stop/redeploy/`docker compose down`) hard-kills the process
 *    immediately by default, cutting off any request that happens to be in flight,
 *    instead of finishing it first.
 */
export function installLifecycleHandlers(server: Server, logger: LifecycleLogger, opts: LifecycleOptions = {}): void {
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ?? 10_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: String(reason) }, "unhandled promise rejection — exiting");
    exit(1);
  });

  process.on("uncaughtException", (err) => {
    logger.error({ err: String(err) }, "uncaught exception — exiting");
    exit(1);
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "received shutdown signal — draining in-flight requests");

    const forceExitTimer = setTimeout(() => {
      logger.error({ signal, shutdownTimeoutMs }, "graceful shutdown timed out — forcing exit");
      exit(1);
    }, shutdownTimeoutMs);
    forceExitTimer.unref();

    server.close((err) => {
      clearTimeout(forceExitTimer);
      if (err) {
        logger.error({ signal, err: String(err) }, "error while closing server");
        exit(1);
        return;
      }
      logger.info({ signal }, "shutdown complete");
      exit(0);
    });
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
