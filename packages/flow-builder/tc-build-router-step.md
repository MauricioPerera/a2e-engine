---
task: build-router-step
kind: group
intent: "Build the engine-valid ROUTER node from a RouterStepSpec composing piece-step chains."
target: src/router-builder.ts
signature: "def buildRouterStep(spec: RouterStepSpec, lastUpdatedDate: string) -> RouterAction"
target_line: 120
budget: { cyclomatic_max: 6, nesting_max: 3, params_max: 2, lines_max: 30 }
deps_allowed: []
forbids: ["Date.now", "I/O", "estado global", "mutar el spec de entrada"]
language: typescript
tests: src/router-builder.test.ts
test_command: "cmd /c npx tsx --test router-builder.test.ts"
integration_test_command: "cmd /c npx tsx --test src/router-builder.test.ts"
children:
  - tc-build-piece-step.md
  - tc-chain-steps.md
integration_tests: src/router-builder.test.ts
depends_on: ["buildPieceStep", "chainSteps", "StepSpec", "PieceAction", "FlowAction"]
spec_version: "0.1"
sign: true
---

## Intent
Construir el nodo `RouterAction` (ramas condicionales) con la forma exacta que el engine valida,
componiendo las funciones puras existentes (`buildPieceStep`, `chainSteps`) para armar cada cadena
hija por rama.

## Interface
```
in:  spec: RouterStepSpec { name, displayName?, type:'router', executionType?('first_match'|'all_match'),
        branches: RouterBranchSpec[], fallback?: { name, steps: StepSpec[] } }
      lastUpdatedDate: string (ISO, por parámetro)
out: RouterAction { name, valid:true, displayName, lastUpdatedDate, type:'ROUTER',
        settings: { executionType, branches: RouterBranch[] }, children: Array<PieceAction|null> }
error: lanza si name inválido, sin branches, operator vacío, steps vacíos, fallback inválido
```

## Invariants
- `name` debe matchear `/^[a-zA-Z0-9_]+$/`; `displayName` default = `name`.
- Al menos 1 branch; cada branch: `operator` no vacío y `steps` no vacío.
- `executionType`: `'all_match'` -> `'EXECUTE_ALL_MATCH'`; cualquier otro/ausente -> `'EXECUTE_FIRST_MATCH'`.
- Por cada branch: `settings.branches[i] = { branchType:'CONDITION', branchName, conditions: [[{firstValue, secondValue: secondValue ?? '', operator, ...(caseSensitive!=null?{caseSensitive}:{})}]] }`.
- Si hay `fallback`: se añade al final `{ branchType:'FALLBACK', branchName: fallback.name }`.
- `children[i] = chainSteps(branch.steps.map(s => buildPieceStep(s, lastUpdatedDate)))`; el fallback aporta su child al final.
- `children.length === settings.branches.length` SIEMPRE.
- `valid: true`; `lastUpdatedDate` viene del parámetro (sin `Date.now`); no muta el spec de entrada.

## Composition
- Hijos (gateados por su propio contrato): `buildPieceStep` (tc-build-piece-step.md), `chainSteps` (tc-chain-steps.md).
- El test de integración (`src/router-builder.test.ts`) importa el target real y los hijos reales, ejercitando
  el ensamble: forma del nodo ROUTER, mapeo de conditions, executionType, fallback + child, validaciones,
  y la composición mezclada vía `buildFlowFromRequest`.

## Tests
`src/router-builder.test.ts` cubre: type ROUTER con branches/children de igual longitud; condition -> [[...]]
con operator/firstValue/secondValue correctos; secondValue default '' y caseSensitive propagado; executionType
mapping; fallback añade branch FALLBACK + child; child es cabeza de la cadena; validaciones lanzan (sin branches,
operator vacío, steps vacíos, name inválido, fallback inválido); buildFlowFromRequest con step router produce
ROUTER; mezcla piece+router encadena vía nextAction; router+router encadena. Oráculo independiente.

## Constraints
- PARAR y reportar si el budget no se cumple sin violar la interfaz. Sin workarounds silenciosos.
- Si una función excede el budget, subdividir en helpers (cada uno con su contrato + tests).