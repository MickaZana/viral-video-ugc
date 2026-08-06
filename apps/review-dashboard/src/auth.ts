import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { loadEnv } from "@vvugc/shared-config";

export interface DashboardCredentials {
  username: string;
  password: string;
  /** True when generated because DASHBOARD_USERNAME/DASHBOARD_PASSWORD were unset — callers should log this once. */
  generated: boolean;
}

export interface AuthLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

/**
 * A structured pino log line is easy to miss/hard to read for the one audience that
 * actually needs this value — someone starting the dashboard for the first time with
 * no .env configured. The generated login is also written here in plain text, so it's
 * discoverable without parsing JSON logs: a non-engineer can just open this file.
 */
export function credentialsFilePath(runsDir: string): string {
  return join(runsDir, "dashboard-credentials.txt");
}

function credentialsBanner(username: string, password: string, filePath: string): string {
  return [
    "",
    "============================================================",
    " Review dashboard login (auto-generated, no .env configured)",
    "============================================================",
    ` Username: ${username}`,
    ` Password: ${password}`,
    "",
    " This changes every restart. For a stable login, set",
    " DASHBOARD_USERNAME and DASHBOARD_PASSWORD in your .env.",
    "",
    ` Also saved to: ${filePath}`,
    "============================================================",
    ""
  ].join("\n");
}

/**
 * Resolves the dashboard's Basic Auth credentials. If both env vars are set,
 * uses them. Otherwise generates a random one-time password rather than ever
 * running unauthenticated — this dashboard approves/rejects content before it
 * ships, which is exactly the kind of endpoint that should never be reachable
 * without credentials, including by accident on a first `docker compose up`
 * with no .env configured yet.
 */
export function resolveCredentials(logger: AuthLogger): DashboardCredentials {
  const { DASHBOARD_USERNAME, DASHBOARD_PASSWORD, VVUGC_RUNS_DIR } = loadEnv();
  const credsPath = credentialsFilePath(VVUGC_RUNS_DIR);

  if (DASHBOARD_USERNAME && DASHBOARD_PASSWORD) {
    // A previously-generated credentials file is now stale (or actively wrong) —
    // remove it so it can't be mistaken for the currently active login.
    try {
      rmSync(credsPath, { force: true });
    } catch {
      // best-effort cleanup only; a leftover stale file is a minor confusion risk,
      // not worth failing startup over.
    }
    return { username: DASHBOARD_USERNAME, password: DASHBOARD_PASSWORD, generated: false };
  }

  // Production must never fall back to a generated credential that could be
  // exposed through startup output or a mounted runs directory. The caller's
  // production validation also checks this, but failing here prevents any
  // generated secret from being logged or persisted before that validation runs.
  if (process.env.NODE_ENV === "production") {
    throw new Error("DASHBOARD_USERNAME and DASHBOARD_PASSWORD are required in production");
  }

  const username = "admin";
  const password = generatePassword();
  logger.warn(
    { username, generated: true },
    "DASHBOARD_USERNAME/DASHBOARD_PASSWORD not set — generated a one-time login for this process " +
      "(logged once, here). Set both env vars for a stable login that survives restarts. This dashboard " +
      "approves/rejects content before it ships; never leave it reachable without credentials."
  );

  const banner = credentialsBanner(username, password, credsPath);
  // Plain console output, deliberately not routed through the JSON structured logger —
  // this is the one message meant for a human skimming the terminal, not a log aggregator.
  console.log(banner);
  try {
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, banner, { mode: 0o600 });
  } catch (err) {
    logger.warn({ err: String(err) }, "failed to write dashboard-credentials.txt — login is still shown above");
  }

  return { username, password, generated: true };
}

/** Constant-time string comparison — a naive `===` leaks timing information proportional
 *  to how many leading characters match, which is enough to brute-force a password
 *  character-by-character over many requests. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do a same-cost comparison so a length mismatch doesn't return faster
    // than a same-length mismatch would.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Parses `Authorization: Basic <base64(user:pass)>`. Returns undefined for any malformed header. */
function parseBasicAuthHeader(header: string | undefined): { user: string; pass: string } | undefined {
  if (!header?.startsWith("Basic ")) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf-8");
  } catch {
    return undefined;
  }
  const sepIndex = decoded.indexOf(":");
  if (sepIndex === -1) return undefined;
  return { user: decoded.slice(0, sepIndex), pass: decoded.slice(sepIndex + 1) };
}

export function createBasicAuthMiddleware(credentials: DashboardCredentials): RequestHandler {
  return (req: Request & { auditActor?: string }, res: Response, next: NextFunction) => {
    const parsed = parseBasicAuthHeader(req.headers.authorization);
    if (
      parsed &&
      timingSafeStringEqual(parsed.user, credentials.username) &&
      timingSafeStringEqual(parsed.pass, credentials.password)
    ) {
      req.auditActor = `operator:${parsed.user}`;
      return next();
    }
    // Only advertise the HTTP Basic challenge to non-AJAX requests (real browser
    // navigations / curl without an explicit Accept), where the native browser
    // login dialog is the expected, desirable UX. For AJAX/XHR requests (the
    // control-panel SPA sends X-Requested-With: XMLHttpRequest on every call) we
    // deliberately omit WWW-Authenticate so the browser never pops its own Basic
    // Auth dialog on a fetch that's going to 401 — the SPA handles the error in
    // its own UI instead.
    if (req.get("X-Requested-With") !== "XMLHttpRequest") {
      res.set("WWW-Authenticate", 'Basic realm="Viral Video UGC Review Dashboard"');
    }
    res.status(401).json({ error: "authentication required" });
  };
}
