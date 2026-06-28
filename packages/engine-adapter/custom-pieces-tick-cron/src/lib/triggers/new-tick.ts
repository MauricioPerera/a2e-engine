import { createTrigger, TriggerStrategy } from "@activepieces/pieces-framework";

// POLLING trigger whose ON_ENABLE advertises a CRON schedule via
// context.setSchedule({ cronExpression, timezone }), so the reactive runner can
// derive its schedule from the hook (cron mode). The RUN hook returns a GROWING
// list [{id:1},..,{id:k}] where k = parseInt(process.env.TICK_COUNT), exactly
// like piece-tick-grow — so the cron demo can bump TICK_COUNT between ticks to
// simulate new items. The cron expression itself is read from
// process.env.CRON_EXPR (default '* * * * *' = every minute). Note: the engine's
// setSchedule validates with cron-validator@1.3.1 WITHOUT {seconds:true}, so
// CRON_EXPR MUST be a 5-field (minute-precision) expression.
function buildItems(): Array<{ id: number; v: string }> {
  const k = Math.max(0, parseInt(process.env.TICK_COUNT ?? "2", 10) || 0);
  const out: Array<{ id: number; v: string }> = [];
  for (let i = 1; i <= k; i++) out.push({ id: i, v: "item-" + i });
  return out;
}

export const newTick = createTrigger({
  name: "new_tick",
  displayName: "New Tick (cron-scheduled)",
  description:
    "POLLING trigger; ON_ENABLE calls setSchedule(CRON_EXPR env, default '* * * * *'). RUN emits [1..TICK_COUNT] items.",
  type: TriggerStrategy.POLLING,
  props: {},
  sampleData: [{ id: 1, v: "item-1" }],
  async onEnable(context) {
    const cronExpression = process.env.CRON_EXPR ?? "* * * * *";
    // setSchedule is what the engine captures into scheduleOptions (POLLING only)
    // and returns in the ON_ENABLE response. timezone defaults to UTC inside the
    // engine when omitted.
    context.setSchedule({ cronExpression, timezone: "UTC" });
  },
  async onDisable(_context) {},
  async test(_context) {
    return buildItems();
  },
  async run(_context) {
    return buildItems();
  },
});