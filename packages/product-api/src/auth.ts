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
