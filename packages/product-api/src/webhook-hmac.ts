// HMAC-SHA256 webhook signing utilities (node:crypto, no deps).
//
// Per-webhook signing: when a WEBHOOK trigger is registered (POST
// /webhook-triggers) a random secret is generated and stored on the registry
// entry. The emitter signs the raw request body with that secret and sends the
// signature in the X-A2E-Signature header. The ingress (POST /webhooks/:id)
// verifies the signature BEFORE firing the flow, so a leaked/guessed triggerId
// alone cannot trigger the flow.
//
// Signature format: "sha256=" + hex(HMAC-SHA256(secret, rawBody)).
// Comparison is TIMING-SAFE (crypto.timingSafeEqual); an absent header or a
// length mismatch returns false WITHOUT throwing.

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

export function computeSignature(secret: string, rawBody: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  return `sha256=${hmac.digest("hex")}`;
}

export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
): boolean {
  if (!header) return false;
  const expected = computeSignature(secret, rawBody);
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
