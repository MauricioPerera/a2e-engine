// In-memory registry of active reactive trigger loops.
// Maps triggerId -> the live ReactiveHandle returned by startReactivePoll.
// The handle exposes mutable `state` (read by GET /triggers/:id) and a `stop()`
// used by DELETE /triggers/:id to clear the timer and halt the loop.
import type { ReactiveHandle } from "../../trigger-runtime/src/poll-runner.js";

export interface TriggerEntry {
  triggerId: string;
  handle: ReactiveHandle;
}

const registry = new Map<string, TriggerEntry>();

export function registerTrigger(triggerId: string, handle: ReactiveHandle): void {
  registry.set(triggerId, { triggerId, handle });
}

export function getTrigger(triggerId: string): TriggerEntry | undefined {
  return registry.get(triggerId);
}

export function removeTrigger(triggerId: string): boolean {
  const entry = registry.get(triggerId);
  if (!entry) return false;
  entry.handle.stop();
  registry.delete(triggerId);
  return true;
}

export function listTriggerIds(): string[] {
  return [...registry.keys()];
}

// ---------------------------------------------------------------------------
// WEBHOOK registry (passive: no loop, waits for POST /webhooks/:id).
// Separate map from the POLLING registry so the POLLING endpoints
// (POST /triggers, GET/DELETE /triggers/:id) are untouched (no-regression).
// A registration holds the trigger spec (pieceName/triggerName to RUN) and the
// static body steps that fire once per item returned by the trigger's run().
// ---------------------------------------------------------------------------
export interface WebhookTriggerSpec {
  pieceName: string;
  pieceVersion?: string;
  triggerName: string;
  input?: Record<string, unknown>;
}

export interface WebhookStepSpec {
  name: string;
  pieceName: string;
  pieceVersion: string;
  actionName: string;
  // Static input. String values equal to "{{item}}" are replaced with
  // JSON.stringify(item) at ingress time (the per-item templating convention;
  // functions cannot cross HTTP, so this is the MVP seed mechanism).
  input?: Record<string, unknown>;
}

export interface WebhookRegistration {
  triggerSpec: WebhookTriggerSpec;
  flowSteps: WebhookStepSpec[];
  // Per-webhook HMAC secret. Generated at registration time; the emitter signs
  // the raw body with this and the ingress verifies X-A2E-Signature against it.
  // Undefined for legacy registrations (no secret -> signing optional/required
  // depending on WEBHOOK_HMAC_OPTIONAL; see handleWebhookIngress).
  signingSecret?: string;
}

export interface WebhookEntry {
  triggerId: string;
  registration: WebhookRegistration;
}

const webhookRegistry = new Map<string, WebhookEntry>();

export function registerWebhookTrigger(
  triggerId: string,
  registration: WebhookRegistration,
): void {
  webhookRegistry.set(triggerId, { triggerId, registration });
}

export function getWebhookTrigger(triggerId: string): WebhookEntry | undefined {
  return webhookRegistry.get(triggerId);
}

export function removeWebhookTrigger(triggerId: string): boolean {
  return webhookRegistry.delete(triggerId);
}

export function listWebhookTriggerIds(): string[] {
  return [...webhookRegistry.keys()];
}
