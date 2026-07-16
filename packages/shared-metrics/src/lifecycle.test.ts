import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLifecycleHandlers, type LifecycleLogger } from "./lifecycle.js";

function makeLogger(): LifecycleLogger & { error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { error: vi.fn(), info: vi.fn() };
}

// unhandledRejection/uncaughtException/SIGTERM/SIGINT are registered on the real
// `process` object — remove every listener this module adds after each test so
// tests don't leak handlers into each other (or into the rest of the test run).
function clearProcessListeners(): void {
  for (const event of ["unhandledRejection", "uncaughtException", "SIGTERM", "SIGINT"] as const) {
    process.removeAllListeners(event);
  }
}

describe("installLifecycleHandlers", () => {
  let server: Server;

  beforeEach(async () => {
    server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    clearProcessListeners();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("logs and exits(1) on an unhandled promise rejection", () => {
    const logger = makeLogger();
    const exit = vi.fn();
    installLifecycleHandlers(server, logger, { exit });

    process.emit("unhandledRejection", new Error("boom"), Promise.resolve());

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0].err).toContain("boom");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs and exits(1) on an uncaught exception", () => {
    const logger = makeLogger();
    const exit = vi.fn();
    installLifecycleHandlers(server, logger, { exit });

    process.emit("uncaughtException", new Error("kaboom"));

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0].err).toContain("kaboom");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("on SIGTERM, closes the server (draining in-flight connections) and exits(0)", async () => {
    const logger = makeLogger();
    const exit = vi.fn();
    installLifecycleHandlers(server, logger, { exit });

    process.emit("SIGTERM");
    // server.close()'s callback fires asynchronously once all connections drain.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info.mock.calls.map((c) => c[1])).toContain("shutdown complete");
  });

  it("on SIGINT, also triggers the same graceful shutdown path", async () => {
    const logger = makeLogger();
    const exit = vi.fn();
    installLifecycleHandlers(server, logger, { exit });

    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("only shuts down once even if multiple signals arrive in quick succession", async () => {
    const logger = makeLogger();
    const exit = vi.fn();
    installLifecycleHandlers(server, logger, { exit });

    process.emit("SIGTERM");
    process.emit("SIGTERM");
    process.emit("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("forces exit(1) if the server doesn't close within the configured timeout", async () => {
    const logger = makeLogger();
    const exit = vi.fn();
    // Simulate a server that never finishes draining (close() callback never fires)
    // by overriding close on this particular server instance.
    const hangingServer = { close: vi.fn() } as unknown as Server;
    installLifecycleHandlers(hangingServer, logger, { exit, shutdownTimeoutMs: 20 });

    process.emit("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error.mock.calls.some((c) => c[1] === "graceful shutdown timed out — forcing exit")).toBe(true);
  });
});
