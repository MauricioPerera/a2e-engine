---
task: okf-no-audience-filter
intent: Emit every piece entry to the catalog.
target: okf-generator.ts
signature: "def generateOkfCatalog(pieces): ..."
target_line: 232
budget:
  cyclomatic: 11
  cognitive: 16
  nesting: 4
  length: 80
  params: 5
language: typescript
deps_allowed: []
forbids: [audience-filter]
test_command: node --import tsx --test okf-generator.test.ts
tests: okf-generator.test.ts
---

# OKF catalog must not filter by audience

## Intent

Emit every action and trigger of each piece to the catalog, including those
marked `audience === 'human'`.

## Interface

`generateOkfCatalog(pieces: PieceMetadataInput[]): OkfFile[]` — unchanged public
signature. Internal emitters iterate over ALL entries of `piece.actions` and
`piece.triggers` with no `audience` filter.

## Invariants

- Every entry in `piece.actions` produces a `<piece>/actions/<name>.md` file.
- Every entry in `piece.triggers` produces a `<piece>/triggers/<name>.md` file.
- Root `index.md` action/trigger counts equal `Object.values(...).length`.
- Root `index.md` and `<piece>/index.md` are always emitted.
- The `audience` value may still appear in tags; it must not gate emission.

## Examples

Example 1:
- Input: piece `json` with actions `humanAction` (audience `human`) and
  `bothAction` (audience `both`), trigger `humanTrigger` (audience `human`).
- Output: paths `json/actions/humanAction.md`, `json/actions/bothAction.md`,
  `json/triggers/humanTrigger.md`, `index.md`, `json/index.md`; root row for
  `json` shows `2` actions.

Example 2:
- Input: piece `empty` with no actions and no triggers.
- Output: paths `index.md` and `empty/index.md`; no `empty/actions/*` or
  `empty/triggers/*` files; root row for `empty` shows `0` actions and `0`
  triggers.

## Do / Don't

- Do iterate `Object.values(piece.actions)` / `Object.values(piece.triggers)`
  directly.
- Don't reintroduce `isAgentVisible` or any `.filter` on `audience`.
- Don't change the public signature of `generateOkfCatalog`.

## Tests

`okf-generator.test.ts` (node:test + node:assert/strict) covers:
human+both actions emitted, root index counts 2 actions, human trigger
emitted, root and per-piece index present.

## Constraints

Budget firmado en front-matter. PARAR y reportar si alguna función tocada
excede el budget o si `node --import tsx --test okf-generator.test.ts` no pasa.