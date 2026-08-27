import { defineMigration, runMigrations as runSharedMigrations, type Migration } from "@vvugc/shared-persistence";

export type { Migration } from "@vvugc/shared-persistence";

/**
 * Ordered, one-way schema migrations — each `id` is applied at most once,
 * tracked in `schema_migrations`. Before this file existed, the Postgres store's
 * schema was a single hardcoded `CREATE TABLE IF NOT EXISTS`, with no way to
 * evolve it later without either editing that statement in place (silently
 * diverging from what's already deployed, since `IF NOT EXISTS` no-ops on an
 * existing table) or hand-writing a one-off ALTER TABLE someone has to remember
 * to run.
 *
 * Append new migrations to the END of this array; never edit or reorder one
 * that's already shipped — a database that already applied it won't re-run it,
 * so an in-place edit would silently diverge from what's actually deployed.
 */
export const MIGRATIONS: readonly Migration[] = [
  defineMigration("0001_create_review_items", `
      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        niche TEXT NOT NULL,
        platform TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS review_items_created_at_idx ON review_items (created_at DESC);
      CREATE INDEX IF NOT EXISTS review_items_status_idx ON review_items (status);
    `),
  defineMigration("0002_add_tenant_scope", `
      ALTER TABLE review_items ADD COLUMN IF NOT EXISTS org_id TEXT;
      ALTER TABLE review_items ADD COLUMN IF NOT EXISTS client_id TEXT;
      CREATE INDEX IF NOT EXISTS review_items_org_id_idx ON review_items (org_id);
      CREATE INDEX IF NOT EXISTS review_items_client_id_idx ON review_items (client_id);
    `),
  defineMigration("0003_create_pipeline_jobs", `
      CREATE TABLE IF NOT EXISTS pipeline_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        org_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        config JSONB NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'dead_letter')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        cancel_requested BOOLEAN NOT NULL DEFAULT false,
        result JSONB,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (org_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS pipeline_jobs_claim_idx
        ON pipeline_jobs (available_at, created_at)
        WHERE status = 'queued';
      CREATE INDEX IF NOT EXISTS pipeline_jobs_lease_idx
        ON pipeline_jobs (lease_expires_at)
        WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS pipeline_jobs_tenant_idx
        ON pipeline_jobs (org_id, client_id, created_at DESC);
    `),
  defineMigration("0004_create_identity_security_state", `
      -- Identity is intentionally normalized: an organization may outlive an
      -- individual member, while membership is the tenant authorization edge.
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (email)
      );
      CREATE TABLE IF NOT EXISTS organization_members (
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'reviewer', 'viewer', 'member')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, account_id),
        -- The existing application model assigns exactly one tenant per account.
        UNIQUE (account_id)
      );
      CREATE INDEX IF NOT EXISTS organization_members_account_idx ON organization_members (account_id, org_id);

      -- Tokens are random opaque credentials, never plaintext password/MFA material.
      CREATE TABLE IF NOT EXISTS account_sessions (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_sessions_account_idx ON account_sessions (account_id);
      CREATE INDEX IF NOT EXISTS account_sessions_expiry_idx ON account_sessions (expires_at);
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        UNIQUE (account_id)
      );
      CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx ON password_reset_tokens (expires_at);
      -- mfa_secret_ciphertext is application-level AEAD ciphertext. The DB never
      -- receives a raw TOTP secret, and a missing encryption key fails startup.
      CREATE TABLE IF NOT EXISTS account_mfa_records (
        account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        secret_ciphertext TEXT NOT NULL,
        confirmed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mfa_challenges (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mfa_challenges_expiry_idx ON mfa_challenges (expires_at);
      CREATE TABLE IF NOT EXISTS oauth_nonces (
        nonce TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS oauth_nonces_expiry_idx ON oauth_nonces (expires_at);
    `),
  defineMigration("0005_create_tenant_profile_state", `
      -- Tenant configuration is normalized around organizations.  Payloads keep
      -- schema-validated profile fields extensible, while ownership/index/FK
      -- columns remain relational and enforceable.
      CREATE TABLE IF NOT EXISTS tenant_settings (
        org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS agency_clients (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (org_id, id)
      );
      CREATE INDEX IF NOT EXISTS agency_clients_org_idx ON agency_clients(org_id);
      CREATE TABLE IF NOT EXISTS product_profiles (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        client_id TEXT,
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (org_id, client_id) REFERENCES agency_clients(org_id, id) ON DELETE CASCADE,
        UNIQUE (org_id, id)
      );
      CREATE INDEX IF NOT EXISTS product_profiles_org_client_idx ON product_profiles(org_id, client_id);
      CREATE TABLE IF NOT EXISTS creator_profiles (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        client_id TEXT,
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (org_id, client_id) REFERENCES agency_clients(org_id, id) ON DELETE CASCADE,
        UNIQUE (org_id, id)
      );
      CREATE INDEX IF NOT EXISTS creator_profiles_org_client_idx ON creator_profiles(org_id, client_id);
      CREATE TABLE IF NOT EXISTS organization_invites (
        token TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','editor','reviewer','viewer','member')),
        invited_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > created_at)
      );
      CREATE INDEX IF NOT EXISTS organization_invites_expiry_idx ON organization_invites(expires_at);
      CREATE INDEX IF NOT EXISTS organization_invites_email_idx ON organization_invites(email);
      -- access/refresh values are application-AEAD ciphertext.  There are no
      -- plaintext token columns in this table by design.
      CREATE TABLE IF NOT EXISTS social_connections (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('tiktok','youtube_shorts','instagram_reels','facebook')),
        account_label TEXT NOT NULL CHECK (length(account_label) > 0),
        provider_account_id TEXT,
        access_ciphertext TEXT NOT NULL CHECK (length(access_ciphertext) > 28),
        refresh_ciphertext TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (org_id, client_id) REFERENCES agency_clients(org_id, id) ON DELETE CASCADE,
        UNIQUE (org_id, client_id, platform)
      );
      CREATE INDEX IF NOT EXISTS social_connections_org_client_idx ON social_connections(org_id, client_id);
    `),
  defineMigration("0006_create_billing_ledger", `
      -- Financial state is append-only where possible. Amounts are integer cents,
      -- never floating point, and every tenant-owned row is anchored to an org.
      CREATE TABLE IF NOT EXISTS billing_plans (
        org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        tier_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('none','active','past_due','canceled')),
        stripe_customer_id TEXT UNIQUE,
        stripe_subscription_id TEXT UNIQUE,
        stripe_event_created_at BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS billing_plans_subscription_idx ON billing_plans(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

      -- A reservation is made before work is dispatched. Its unique org/run key
      -- makes retries idempotent, while the org advisory lock in the repository
      -- serializes allowance allocation across workers.
      CREATE TABLE IF NOT EXISTS billing_run_reservations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        client_id TEXT,
        billing_month TEXT NOT NULL CHECK (billing_month ~ '^\\d{4}-\\d{2}$'),
        kind TEXT NOT NULL CHECK (kind IN ('included','overage')),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved','settled','released')) DEFAULT 'reserved',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        settled_at TIMESTAMPTZ,
        released_at TIMESTAMPTZ,
        UNIQUE(org_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS billing_run_reservations_org_month_idx ON billing_run_reservations(org_id,billing_month,status,created_at);

      CREATE TABLE IF NOT EXISTS billing_overage_charges (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        reservation_id TEXT REFERENCES billing_run_reservations(id) ON DELETE RESTRICT,
        client_id TEXT,
        billing_month TEXT NOT NULL CHECK (billing_month ~ '^\\d{4}-\\d{2}$'),
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        estimated_vendor_cost_cents INTEGER NOT NULL CHECK (estimated_vendor_cost_cents >= 0),
        duration_sec INTEGER CHECK (duration_sec > 0),
        duration_multiplier_basis_points INTEGER CHECK (duration_multiplier_basis_points > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(org_id, run_id)
      );
      CREATE INDEX IF NOT EXISTS billing_overage_charges_org_month_idx ON billing_overage_charges(org_id,billing_month,created_at DESC);

      -- Stripe deliveries are durable receipts. A row is inserted in the same
      -- transaction as subscription effects, so a successful retry cannot apply
      -- an event twice. Payload is retained only for reconciliation/audit.
      CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        status TEXT NOT NULL CHECK (status IN ('processed','ignored','failed')),
        org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS stripe_webhook_events_org_idx ON stripe_webhook_events(org_id,processed_at DESC);
    `),
  defineMigration("0007_create_provider_jobs", `
      -- Provider jobs are the durable, tenant-scoped handoff from orchestration
      -- to video workers. An organization delete is intentionally terminal for
      -- all of its work; deleting a client is restricted while jobs reference it.
      CREATE TABLE IF NOT EXISTS provider_jobs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        script_segment_index INTEGER NOT NULL CHECK (script_segment_index >= 0),
        requested_vendor TEXT NOT NULL,
        fallback_vendors JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fallback_vendors) = 'array'),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
        status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','dead_letter','cancelled')),
        available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        cancel_requested BOOLEAN NOT NULL DEFAULT false,
        idempotency_key TEXT NOT NULL,
        estimated_cost DOUBLE PRECISION,
        actual_cost DOUBLE PRECISION,
        actual_vendor TEXT,
        provider_request_id TEXT,
        last_error TEXT,
        fallback_reason TEXT,
        request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object'),
        result JSONB,
        routing_decision JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        FOREIGN KEY (org_id, client_id) REFERENCES agency_clients(org_id, id) ON DELETE RESTRICT,
        UNIQUE (org_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS provider_jobs_claim_idx ON provider_jobs(available_at, created_at) WHERE status='queued';
      CREATE INDEX IF NOT EXISTS provider_jobs_lease_idx ON provider_jobs(lease_expires_at) WHERE status='running';
      CREATE INDEX IF NOT EXISTS provider_jobs_run_idx ON provider_jobs(run_id, script_segment_index, created_at);
      CREATE INDEX IF NOT EXISTS provider_jobs_tenant_idx ON provider_jobs(org_id, client_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS provider_jobs_dlq_idx ON provider_jobs(org_id, updated_at DESC) WHERE status='dead_letter';
    `)
];

/**
 * Applies every migration in `migrations` (defaults to the real `MIGRATIONS` list —
 * overriding it is for tests exercising this function's own error handling, not a
 * normal call site) not yet recorded in `schema_migrations`, in order, each inside
 * its own transaction — a failure partway through a migration rolls back instead of
 * leaving it half-applied-but-marked-done, so the next call retries it rather than
 * skipping it as already-done. Safe to call on every process startup: a
 * fully-migrated database just checks and returns.
 */
export async function runMigrations(pool: import("pg").Pool, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  await runSharedMigrations(pool, migrations);
}
