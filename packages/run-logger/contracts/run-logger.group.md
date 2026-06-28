---
task: run-logger-okf
intent: Renderizar documentos OKF de run e indice diario a partir de datos de entrada.
target: contracts/run-logger.group.md
kind: group
language: typescript
children:
  - contracts/redact-value.md
  - contracts/run-file-path.md
  - contracts/render-run-doc.md
  - contracts/render-day-index.md
integration_tests: src/run-logger.test.ts
integration_test_command: npx tsx --test run-logger.test.ts
budget:
  cyclomatic: 10
  nesting: 3
  params: 4
  lines: 40
---

## Intent
Producir el documento OKF markdown de un `FlowRun` y el indice diario de runs, a partir de datos de entrada (sin red, FS, git ni `Date`).

## Interface
Composicion de 4 funciones exportadas (children) mas helpers internos (`escapeYaml`, `formatErrorLine`, `renderFrontmatter`, `renderStepItem`, `renderStepsSection`, `renderErrorSection`) que mantienen cada funcion dentro de budget:
- `redactValue(value, maxLen=2000)` -> string seguro truncado.
- `runFilePath(run)` -> `{dir, file}`.
- `renderRunDoc(run)` -> documento OKF (frontmatter + `# Run` + `## Steps` + `## Error` si fallo).
- `renderDayIndex(date, runs)` -> indice diario (frontmatter + tabla con links).

## Invariants
- Sin red, FS, git, ni `Date` (timestamps son strings).
- `redactValue` nunca lanza.
- Frontmatter YAML valido.
- `## Error` y campos `failedStep`/`error` solo si `status !== 'SUCCEEDED'`.

## Examples
- run SUCCEEDED -> doc sin `failedStep:` ni `## Error`.
- run FAILED -> doc con `failedStep:`, `error:` y `## Error` con stack en bloque ```.
- `renderDayIndex` -> tabla con una fila por run y link `/runs/<date>/run-<runId>.md`.

## Do / Don't
- DO: subdividir render en helpers dentro de budget.
- DON'T: usar `Date`, FS, red, git.

## Tests
Oraculo congelado en `src/run-logger.test.ts` (node:test + node:assert) cubriendo los 4 exportados y los casos de la definicion de hecho.

## Constraints
- TypeScript ESM, Node, sin frameworks ni deps de Activepieces.
- Budget por funcion: cyclomatic<=10, nesting<=3, params<=4, lines<=40.
- Exportar `redactValue`, `runFilePath`, `renderRunDoc`, `renderDayIndex` y tipos `FlowRun`, `StepRecord`.
- PARAR y reportar si una funcion no puede quedar dentro de budget sin perder claridad, o si un test no puede pasar sin `Date`/FS/red.