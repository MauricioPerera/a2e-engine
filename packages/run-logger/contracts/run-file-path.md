---
task: run-file-path
intent: Derivar la ruta runs/<fecha>/run-<id>.md de un run.
target: src/run-logger.ts
kind: function
language: typescript
signature: "def runFilePath(run)"
test_command: npx tsx --test run-file-path.test.ts
deps_allowed: []
tests: src/run-file-path.test.ts
budget:
  cyclomatic: 10
  nesting: 3
  params: 4
  lines: 40
---

## Intent
Calcular la ruta (dir + file) del documento OKF de un run a partir de `startedAt` y `runId`.

## Interface
`runFilePath(run: FlowRun): { dir: string; file: string }`

## Invariants
- `dir = "runs/" + run.startedAt.slice(0, 10)` (fecha YYYY-MM-DD del ISO).
- `file = "run-" + run.runId + ".md"`.
- Solo strings; sin `Date`, sin FS.

## Examples
- `startedAt: "2026-06-28T10:00:00.000Z"`, `runId: "r1"` -> `{dir:"runs/2026-06-28", file:"run-r1.md"}`.
- `startedAt: "2025-01-02T03:04:05.000Z"`, `runId: "abc"` -> `{dir:"runs/2025-01-02", file:"run-abc.md"}`.

## Do / Don't
- DO: usar `slice(0,10)` para la fecha.
- DON'T: usar `new Date(...)`.

## Tests
Oraculo congelado (node:test + node:assert).

## Constraints
- Budget: cyclomatic<=10, nesting<=3, params<=4, lines<=40.
- PARAR y reportar si la fecha no se puede derivar por slice solo.