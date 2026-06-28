---
task: build-loop-step
intent: Construir el nodo LOOP_ON_ITEMS a partir de un LoopStepSpec
target: ../../src/loop-builder.ts
kind: function
language: typescript
signature: "def buildLoopStep(spec, lastUpdatedDate)"
target_line: 48
budget:
  cyclomatic: 5
  cognitive: 7
  nesting: 2
  length: 20
  params: 3
deps_allowed: []
test_command: node --import tsx --test loop-builder.test.ts
tests: ../../src/loop-builder.test.ts
---

# buildLoopStep — nodo LOOP_ON_ITEMS

## Intent
Construir el nodo `LOOP_ON_ITEMS` (engine-facing) a partir de un `LoopStepSpec`
(agent-facing), reutilizando `buildPieceStep` y `chainSteps` de `flow-builder` para armar
el cuerpo del loop. Función pura: solo arma JSON, no ejecuta nada.

## Interface
- Entrada: `spec: LoopStepSpec` (`{ name, displayName?, type: "loop", items: string, steps: StepSpec[] }`),
  `lastUpdatedDate: string`.
- Salida: `LoopOnItemsAction` (`{ name, valid, displayName, lastUpdatedDate, type: "LOOP_ON_ITEMS",
  settings: { items }, firstLoopAction?, nextAction? }`).
- Dependencias permitidas: ninguna de tercero (solo stdlib + `./flow-builder.js`).

## Invariants
- `valid` siempre `true`; `type` siempre `"LOOP_ON_ITEMS"`.
- `displayName` default = `spec.name`.
- `settings.items` === `spec.items` (sin transformar).
- `firstLoopAction` es la cabeza de la cadena de `spec.steps` mapeados con `buildPieceStep`.
- No muta `spec` ni sus `steps`.

## Examples
- `buildLoopStep({ name: "loop_1", type: "loop", items: "{{trigger.list}}", steps: [pieceStep("a"), pieceStep("b")] }, DATE)`
  -> nodo con `type: "LOOP_ON_ITEMS"`, `settings.items: "{{trigger.list}}"`,
  `firstLoopAction.name === "a"` y `firstLoopAction.nextAction.name === "b"`.
- `buildLoopStep({ name: "loop_1", type: "loop", items: "{{x}}", steps: [pieceStep("only")] }, DATE)`
  -> nodo con `firstLoopAction.name === "only"` y `firstLoopAction.nextAction === undefined`.
- `buildLoopStep({ name: "bad name", type: "loop", items: "{{x}}", steps: [pieceStep("a")] }, DATE)`
  -> lanza `Error: buildLoopStep: name "bad name" must match /^[a-zA-Z0-9_]+$/`.

## Do / Don't
- DO: reutilizar `buildPieceStep` y `chainSteps` (no reimplementar).
- DO: validar antes de construir (fail-fast).
- DON'T: expandir `{{...}}` ni interpretar la expresión `items` — el agente la arma.
- DON'T: mutar `spec` ni inyectar el item actual del loop (responsabilidad del agente).

## Tests
Tests congelados en `src/loop-builder.test.ts` (oráculo independiente, valores esperados
inline). Cubren: forma del nodo, cadena del cuerpo, defaults y las tres validaciones.

## Constraints
- Complejidad bajo el budget firmado (cicomático ≤5, cognitivo ≤7, anidamiento ≤2,
  longitud ≤20, parámetros ≤3).
- Pureza: sin `Date.now`, sin I/O, sin mutación de entradas.
- PARAR y reportar si alguna función supera el budget: no reimplementar, subdividir.