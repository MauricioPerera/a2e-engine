import { createTrigger, TriggerStrategy } from '@activepieces/pieces-framework';

// Minimal POLLING trigger. test() and run() both return a FIXED list, no network.
const ITEMS = [
  { id: 1, v: 'a' },
  { id: 2, v: 'b' },
];

export const newTick = createTrigger({
  name: 'new_tick',
  displayName: 'New Tick',
  description: 'Emits a fixed controlled list of items (no network).',
  type: TriggerStrategy.POLLING,
  props: {},
  sampleData: ITEMS,
  async onEnable(_context) {
    // no-op for the probe
  },
  async onDisable(_context) {
    // no-op for the probe
  },
  async test(_context) {
    return ITEMS;
  },
  async run(_context) {
    return ITEMS;
  },
});
