import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import pino from "pino";
import { z } from "zod";
import { loadEnv } from "@vvugc/shared-config";

const logger = pino({ name: "vvugc-marketing-site-waitlist" });

const EmailSchema = z.string().trim().email();

export interface WaitlistSubmissionResult {
  ok: boolean;
  error?: string;
}

export function waitlistPath(): string {
  const { VVUGC_RUNS_DIR } = loadEnv();
  return join(VVUGC_RUNS_DIR, "waitlist.jsonl");
}

/**
 * Persists locally first (the durable record — always succeeds or the whole
 * submission fails), then best-effort forwards to WAITLIST_WEBHOOK_URL if
 * configured (Zapier/Make/a Google Apps Script Web App backed by a Sheet,
 * etc). A webhook failure is logged, not surfaced to the submitter — their
 * email is already safely recorded locally either way.
 */
export async function recordWaitlistSubmission(rawEmail: unknown): Promise<WaitlistSubmissionResult> {
  const parsed = EmailSchema.safeParse(rawEmail);
  if (!parsed.success) {
    return { ok: false, error: "Enter a valid email address." };
  }
  const email = parsed.data;

  const path = waitlistPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ email, submittedAt: new Date().toISOString() }) + "\n");

  const { WAITLIST_WEBHOOK_URL } = loadEnv();
  if (WAITLIST_WEBHOOK_URL) {
    try {
      const res = await fetch(WAITLIST_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, submittedAt: new Date().toISOString(), source: "marketing-site" })
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "waitlist webhook forward returned a non-2xx status");
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "waitlist webhook forward failed — submission is still recorded locally");
    }
  }

  return { ok: true };
}
