/**
 * Session auth for the control panel. Unlike the earlier operator-Basic-Auth
 * approach, the app now authenticates through the backend's real account system:
 * signup/login set an HttpOnly, SameSite=Strict session cookie (managed by the
 * browser), and the server's dual-auth gate lets that session reach the data
 * endpoints (/stats, /queue, ...) as well as the /accounts/* routes.
 *
 * The browser handles the cookie itself — this module only persists the CSRF
 * token (needed for state-changing requests) and the signed-in account, and
 * exposes helpers the API client and UI use. Nothing sensitive is stored here.
 */

const CSRF_KEY = 'vvugc-csrf-token'
const ACCOUNT_KEY = 'vvugc-account'

export interface PublicAccount {
  id: string
  email: string
  orgId: string
  role: string
  orgName?: string
}

/** Minimal session snapshot used by the UI shell. */
export interface SessionUser {
  accountId: string
  email: string
  orgName?: string
  role: string
}

export function loadCsrf(): string | null {
  return sessionStorage.getItem(CSRF_KEY)
}

export function saveCsrf(token: string | null): void {
  if (token) sessionStorage.setItem(CSRF_KEY, token)
  else sessionStorage.removeItem(CSRF_KEY)
}

export function loadAccount(): PublicAccount | null {
  const raw = sessionStorage.getItem(ACCOUNT_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw) as PublicAccount
  } catch {
    return null
  }
}

export function saveAccount(account: PublicAccount): void {
  sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account))
}

export function clearSession(): void {
  sessionStorage.removeItem(CSRF_KEY)
  sessionStorage.removeItem(ACCOUNT_KEY)
}
