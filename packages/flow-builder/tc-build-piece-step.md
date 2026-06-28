---
task: build-piece-step
intent: "Build a PIECE PieceAction node from a StepSpec."
target: src/flow-builder.ts
signature: "def buildPieceStep(spec: StepSpec, lastUpdatedDate: string) -> PieceAction"
budget: { cyclomatic_max: 3, nesting_max: 2, lines_max: 20, params_max: 2 }
deps_allowed: []
forbids: ["Date.now", "I/O", "estado global", "mutar spec"]
language: typescript
tests: src/flow-builder.test.ts
test_command: "cmd /c npx tsx --test flow-builder.test.ts"
spec_version: "0.1"
sign: true
---

## Intent
Construir el nodo PieceAction con la forma exacta que el engine valida, a partir de un StepSpec.

## Interface
```
in:  spec: StepSpec, lastUpdatedDate: string (ISO, pasado por parámetro)
out: PieceAction { name, valid:true, displayName, lastUpdatedDate, type:"PIECE",
     settings:{ pieceName, pieceVersion, actionName, input, propertySettings, errorHandlingOptions:undefined } }
error: lanza si spec es inválido (delega a validateStepSpec)
```

## Invariants
- `valid === true`, `type === "PIECE"`, `settings.errorHandlingOptions === undefined`.
- `displayName` por defecto = `spec.name` cuando `spec.displayName` es undefined.
- `settings.propertySettings` tiene una key `{} ` por cada key de `spec.input` (vacío si input vacío).
- `settings.input` preserva strings de `connectionRef` sin transformarlos.
- `lastUpdatedDate` viene del parámetro (no Date.now interno).
- No muta `spec`.

## Examples
- spec(name "step_1", input {a:1,b:2}) con date "2026-01-01T00:00:00.000Z" → node.settings.propertySettings == {a:{}, b:{}}
- spec con input { auth: "{{connections['slack']}}" } → node.settings.input.auth == "{{connections['slack']}}"

## Do / Don't
- DO: validar con validateStepSpec; un bucle para propertySettings.
- DON'T: no usar Date.now, no mutar spec, no I/O, no estado global.

## Tests
`src/flow-builder.test.ts` cubre forma exacta, displayName default, propertySettings por key de input, validación delegada y preservación de connectionRef.

## Constraints
- PARAR y reportar si el budget no se cumple sin violar la interfaz. Sin workarounds silenciosos.