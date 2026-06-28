import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { newTick } from "./lib/triggers/new-tick.ts";

export const tick = createPiece({
  displayName: "TickCron",
  description:
    "Demo POLLING trigger. ON_ENABLE calls setSchedule(CRON_EXPR env, default '* * * * *'); RUN emits [1..TICK_COUNT] items.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.30.0",
  logoUrl: "https://cdn.activepieces.com/pieces/new-core/json-helper.svg",
  authors: ["myorg"],
  actions: [],
  triggers: [newTick],
});