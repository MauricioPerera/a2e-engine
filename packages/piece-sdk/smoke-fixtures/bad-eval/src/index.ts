// Synthetic bad piece: no description, no actions, and an eval() call.
// Used to prove the CLI exits 1 on a failing piece.
const x = eval('1 + 1');
export const bad = createPiece({
  displayName: 'Bad',
  actions: [],
  triggers: [],
});
void x;