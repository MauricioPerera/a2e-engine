---
task: loop-composition
intent: Encadenar un step loop dentro de buildFlowFromRequest via nextAction.
target: ccdd/contracts/loop-composition.md
kind: group
language: typescript
signature: "def buildFlowFromRequest(req, lastUpdatedDate)"
target_line: 1
budget:
  cyclomatic: 5
  cognitive: 7
  nesting: 2
  length: 20
  params: 3
children:
  - build-loop-step.md
integration_tests: ../../src/loop-builder.test.ts
integration_test_command: node --import tsx --test ../../src/loop-builder.test.ts ../../src/build-from-request.test.ts ../../src/router-builder.test.ts
---

# Composición LOOP_ON_ITEMS en el flow builder

## Contexto
`buildFlowFromRequest` (en `src/flow-builder.ts`) compone nodos `FlowAction` según el `type`
de cada step del request y los encadena via `nextAction`. Ahora soporta tres tipos mezclados:
- `type === "router"` -> `buildRouterStep` (ROUTER)
- `type === "loop"` -> `buildLoopStep` (LOOP_ON_ITEMS)
- sin `type` u otro -> `buildPieceStepFromReq` (PIECE)

`buildLoopStep` (en `src/loop-builder.ts`) reutiliza `buildPieceStep` + `chainSteps` de
`flow-builder` para armar `firstLoopAction` (la cabeza del cuerpo del loop).

## Regla de parada
La composición se considera correcta cuando, importando los módulos hijos REALES:
1. Un step `loop` produce un nodo `type: "LOOP_ON_ITEMS"` con `settings.items` y
   `firstLoopAction` = cabeza de la cadena del cuerpo.
2. Una mezcla piece+loop+router se encadena via `nextAction` en el orden dado.
3. Los steps sin `type` siguen siendo piece steps (compatibilidad hacia atrás).

## Tests congelados (oráculo independiente)
`src/loop-builder.test.ts` define los valores esperados inline (no importa nada del target
más allá de las funciones bajo prueba). Las suites `build-from-request.test.ts` y
`router-builder.test.ts` siguen pasando intactas (no se rompió compatibilidad).