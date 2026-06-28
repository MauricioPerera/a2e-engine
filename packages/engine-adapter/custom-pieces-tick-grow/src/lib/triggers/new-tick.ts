import { createTrigger, TriggerStrategy } from "@activepieces/pieces-framework";

// POLLING trigger whose RUN returns a GROWING list [{id:1},..,{id:k}] where
// k = parseInt(process.env.TICK_COUNT). Runs in-process via the engine bundle,
// so the reactive runner can bump TICK_COUNT between ticks to simulate new items.
function buildItems(): Array<{ id: number; v: string }> {
  const k = Math.max(0, parseInt(process.env.TICK_COUNT ?? "2", 10) || 0);
  const out: Array<{ id: number; v: string }> = [];
  for (let i = 1; i <= k; i++) out.push({ id: i, v: "item-" + i });
  return out;
}

export const newTick = createTrigger({
  name: "new_tick",
  displayName: "New Tick (growing)",
  description: "Emits [1..TICK_COUNT] items (no network).",
  type: TriggerStrategy.POLLING,
  props: {},
  sampleData: [{ id: 1, v: "item-1" }],
  async onEnable(_context) {},
  async onDisable(_context) {},
  async test(_context) {
    return buildItems();
  },
  async run(_context) {
    return buildItems();
  },
});
