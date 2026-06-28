import { createPiece, PieceAuth } from "@activepieces/pieces-framework";
import { newTick } from "./lib/triggers/new-tick";

export const tick = createPiece({
  displayName: "TickGrow",
  description: "Demo POLLING trigger returning [1..k] where k = env TICK_COUNT.",
  auth: PieceAuth.None(),
  minimumSupportedRelease: "0.30.0",
  logoUrl: "https://cdn.activepieces.com/pieces/new-core/json-helper.svg",
  authors: ["myorg"],
  actions: [],
  triggers: [newTick],
});
