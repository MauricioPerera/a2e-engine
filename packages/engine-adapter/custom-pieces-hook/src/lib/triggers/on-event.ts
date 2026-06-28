import { createTrigger, TriggerStrategy } from '@activepieces/pieces-framework';

// Minimal WEBHOOK trigger. The engine calls the RUN hook once per inbound HTTP
// event; context.payload is the resolved TriggerPayload (see engine-operation.ts):
//   { body, rawBody?, method?, headers: Record<string,string>, queryParams: Record<string,string> }
// We emit the inbound body as the single item; the flow body fires once per item.
//
// HANDSHAKE (deferred per scope): the engine exposes TriggerHookType.HANDSHAKE,
// which calls pieceTrigger.onHandshake(context) and returns
// { response: { status, body?, headers? } }. Our piece does NOT define
// onHandshake, so the product-api ingress does NOT invoke HANDSHAKE — it just
// runs RUN. If a piece later defines onHandshake, the ingress could detect a
// handshake request (e.g. a header/param/query marker) and call hookType
// HANDSHAKE instead of RUN; that is out of scope for this MVP.
export const onEvent = createTrigger({
  name: 'on_event',
  displayName: 'On Webhook Event',
  description: 'Fires on each inbound HTTP event. Emits the request body as the item.',
  type: TriggerStrategy.WEBHOOK,
  props: {},
  sampleData: { hello: 'world' },
  async onEnable(_context) {
    // no-op: WEBHOOK triggers in this product are passive; the product-api
    // ingress endpoint is the webhook target, not an external subscription.
  },
  async onDisable(_context) {
    // no-op
  },
  async test(context) {
    return [context.payload?.body ?? { test: true }];
  },
  async run(context) {
    return [context.payload?.body];
  },
});