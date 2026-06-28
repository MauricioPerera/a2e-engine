---
task: render-run-doc
intent: Componer el documento OKF markdown de un run.
target: src/run-logger.ts
kind: function
language: typescript
signature: "def renderRunDoc(run)"
test_command: npx tsx --test render-run-doc.test.ts
deps_allowed: []
tests: src/render-run-doc.test.ts
budget:
  cyclomatic: 10
  nesting: 3
  params: 4
  lines: 40
---

## Intent
Ensamblar frontmatter YAML + cuerpo markdown (`# Run`, `## Steps`, `## Error` si fallo) delegando a helpers para quedar dentro de budget.

## Interface
`renderRunDoc(run: FlowRun): string`

## Invariants
- Frontmatter con type/runId/source/status/startedAt/finishedAt/durationMs; si `status !== "SUCCEEDED"` anade failedStep y error (linea `name: message` escapada).
- Cuerpo: `# Run <runId> — <status>`, `## Steps` con un item por step (`- <name> — <status>`, linea de output redactado si hay, message + bloque ``` con stack si error de step).
- Si fallo, seccion `## Error` con name/message y stack en bloque ```.
- Sin `Date`, FS, red.

## Examples
- run SUCCEEDED -> doc con `status: SUCCEEDED`, sin `failedStep:`, sin `## Error`.
- run FAILED -> doc con `failedStep:`, `error:`, seccion `## Error` y stack en ```.

## Do / Don't
- DO: delegar frontmatter/steps/error a helpers (`renderFrontmatter`, `renderStepsSection`, `renderErrorSection`).
- DON'T: inlinear tanto que exceda nesting/cyclomatic.
- DON'T: usar `Date`/FS/red.

## Tests
Oraculo congelado (node:test + node:assert) con runs SUCCEEDED y FAILED.

## Constraints
- Budget: cyclomatic<=10, nesting<=3, params<=4, lines<=40.
- PARAR y reportar si el ensamble no cabe en budget sin perder claridad.