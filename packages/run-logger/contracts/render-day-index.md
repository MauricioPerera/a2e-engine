---
task: render-day-index
intent: Componer el indice diario de runs como tabla markdown con links.
target: src/run-logger.ts
kind: function
language: typescript
signature: "def renderDayIndex(date, runs)"
test_command: npx tsx --test render-day-index.test.ts
deps_allowed: []
tests: src/render-day-index.test.ts
budget:
  cyclomatic: 10
  nesting: 3
  params: 4
  lines: 40
---

## Intent
Producir el documento OKF `index` del dia: frontmatter + `# Runs <date>` + tabla con una fila por run.

## Interface
`renderDayIndex(date: string, runs: FlowRun[]): string`

## Invariants
- Frontmatter: `type: index`, `title: Runs <date>`, `date: <date>`.
- Cuerpo: `# Runs <date>` + tabla `| Run | Status | Duration (ms) | Failed step |` + fila por run.
- Fila: `| [<runId>](/runs/<date>/run-<runId>.md) | <status> | <durationMs> | <failedStep o vacio> |`.
- Sin `Date`, FS, red.

## Examples
- 2 runs (SUCCEEDED, FAILED) -> tabla con 2 filas, status por run y link al doc del run.
- 0 runs -> tabla solo con cabecera (`| Run | Status | Duration (ms) | Failed step |`).

## Do / Don't
- DO: delegar la fila a un helper `renderIndexRow` si la tabla excede budget.
- DON'T: usar `Date`/FS/red.

## Tests
Oraculo congelado (node:test + node:assert) con N runs.

## Constraints
- Budget: cyclomatic<=10, nesting<=3, params<=4, lines<=40.
- PARAR y reportar si la tabla no cabe en budget sin helper.