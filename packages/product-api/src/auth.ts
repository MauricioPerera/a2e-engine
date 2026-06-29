// API-key auth for product-api. Enforced ONLY when API_KEYS env is set;
// when unset, the API runs in open DEV mode (retro-compatible with the
// existing smokes, which send no key). Webhook ingress (POST /webhooks/:id)
// is exempt: external emitters do not hold the API-key; the triggerId (uuid)
// is the bearer secret for now.
import type { IncomingMessage } from "node:http";

// key -> associated projectId (undefined when the key has no ":project" suffix).
export interface ApiKeyConfig {
  keys: Map<string, string | undefined>;
}

// Parse API_KEYS: "key1:projectA,key2:projectB" or "key1,key2". Empty/whitespace
// -> null (dev mode). Returns null when the env var is unset/empty.
export function parseApiKeys(raw: string | undefined): ApiKeyConfig | null {
  if (!raw || raw.trim() === "") return null;
  const keys = new Map<string, string | undefined>();
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const idx = entry.indexOf(":");
    if (idx >= 0) {
      const key = entry.slice(0, idx).trim();
      const project = entry.slice(idx + 1).trim();
      if (key) keys.set(key, project || undefined);
    } else if (entry) {
      keys.set(entry, undefined);
    }
  }
  return keys.size > 0 ? { keys } : null;
}

// Extract the API key from X-API-Key or "Authorization: Bearer <key>".
export function extractApiKey(req: IncomingMessage): string | undefined {
  const xKey = req.headers["x-api-key"];
  if (typeof xKey === "string" && xKey.length > 0) return xKey;
  if (Array.isArray(xKey) && xKey.length > 0) return String(xKey[0]);
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

export interface AuthResult {
  valid: boolean;
  projectId?: string;
}

// Validate the request key against the config. Does NOT mutate the response.
export function authenticate(req: IncomingMessage, cfg: ApiKeyConfig): AuthResult {
  const key = extractApiKey(req);
  if (!key || !cfg.keys.has(key)) return { valid: false };
  return { valid: true, projectId: cfg.keys.get(key) };
}

// The ONLY exempt route: webhook ingress. External emitters don't hold the
// API-key, so the triggerId (uuid, unguessable) acts as the auth token.
// TODO: per-webhook HMAC signing secret verified at ingress for stronger auth.
export function isWebhookIngress(method: string, pathname: string): boolean {
  return method === "POST" && pathname.startsWith("/webhooks/");
}


// --- ADMIN PLANE (operator-only, separate from the agent plane) -----------
// The agent plane uses X-API-Key (API_KEYS). The admin plane uses a DISTINCT
// token (ADMIN_TOKEN) and is gated by requireAdmin below. The two planes are
// fully separate: the agent X-API-Key never authorizes /admin, and ADMIN_TOKEN
// must NOT be one of the agent API_KEYS (configuration invariant; the operator
// sets distinct env values).
//
// If ADMIN_TOKEN is unset/empty, the whole admin plane is DISABLED: every
// /admin/* route returns 404 admin disabled (see server.ts). A deployment that
// does not need operator access can simply leave it unset and the surface for
// credential-loading disappears entirely.

// True when the admin plane is armed (ADMIN_TOKEN set to a non-empty value).
export function isAdminEnabled(): boolean {
  const t = process.env.ADMIN_TOKEN;
  return typeof t === "string" && t.length > 0;
}

export type AdminAuthReason = "disabled" | "unauthorized" | "ok";

export interface AdminAuthResult {
  ok: boolean;
  reason: AdminAuthReason;
}

// Enforce the admin token on a request. Does NOT mutate the response.
//   - ADMIN_TOKEN unset/empty        -> { ok:false, reason: "disabled" }
//   - header missing or wrong token -> { ok:false, reason: "unauthorized" }
//   - header === ADMIN_TOKEN        -> { ok:true,  reason: "ok" }
// The agent X-API-Key is deliberately NOT consulted here.
export function requireAdmin(req: IncomingMessage): AdminAuthResult {
  const expected = process.env.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected.length === 0) {
    return { ok: false, reason: "disabled" };
  }
  const provided = req.headers["x-admin-token"];
  const token = Array.isArray(provided) ? String(provided[0]) : provided;
  if (typeof token !== "string" || token.length === 0 || token !== expected) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true, reason: "ok" };
}
