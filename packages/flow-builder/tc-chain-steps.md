---
task: chain-steps
intent: "Chain PieceAction steps via nextAction, returning the head."
target: src/flow-builder.ts
signature: "def chainSteps(steps: list) -> object"
budget: { cyclomatic_max: 4, nesting_max: 2, lines_max: 10, params_max: 1 }
deps_allowed: []
forbids: ["Date.now", "I/O", "estado global", "mutar los inputs originales"]
language: typescript
tests: src/flow-builder.test.ts
test_command: "cmd /c npx tsx --test flow-builder.test.ts"
spec_version: "0.1"
sign: true
---

## Intent
Enlazar pasos en secuencia vía `nextAction` devolviendo la cabeza, o null si el array está vacío.

## Interface
```
in:  steps: PieceAction[]
out: PieceAction (la cabeza con la cadena nextAction) | null
error: no lanza; array vacío => null
```

## Invariants
- `chainSteps([])` === null.
- Para [a, b, c]: head === a, a.nextAction === b, b.nextAction === c, c.nextAction === undefined.
- No muta los nodos originales de `steps` (devuelve clones).
- Función pura: sin I/O, sin Date.now, sin estado.

## Examples
- `chainSteps([])` → null
- `chainSteps([a,b])` → head.name == a.name y head.nextAction.name == b.name; `a.nextAction` del original sigue undefined

## Do / Don't
- DO: clonar superficialmente cada nodo antes de enlazar.
- DON'T: no mutar los inputs, no I/O, no Date.now, no estado global.

## Tests
`src/flow-builder.test.ts` cubre el encadenamiento en orden, la cabeza devuelta, `chainSteps([])` → null y la no-mutación de los originales.

## Constraints
- PARAR y reportar si el budget no se cumple sin violar la interfaz. Sin workarounds silenciosos.