---
task: validate-step-spec
intent: "Reject any invalid StepSpec field with a clear error."
target: src/flow-builder.ts
signature: "def validateStepSpec(spec: StepSpec) -> None"
budget: { cyclomatic_max: 6, nesting_max: 2, lines_max: 12, params_max: 1 }
deps_allowed: []
forbids: ["Date.now", "I/O", "estado global", "mutar spec"]
language: typescript
tests: src/flow-builder.test.ts
test_command: "cmd /c npx tsx --test flow-builder.test.ts"
spec_version: "0.1"
sign: true
---

## Intent
Validar un StepSpec lanzando Error con mensaje claro si algún campo obligatorio es inválido.

## Interface
```
in:  spec: StepSpec
out: void (no lanza si todo ok)
error: lanza si name no matchea /^[a-zA-Z0-9_]+$/, o pieceName/pieceVersion/actionName vacíos
```

## Invariants
- No lanza cuando name matchea `/^[a-zA-Z0-9_]+$/` y pieceName, pieceVersion, actionName son no vacíos.
- Cada caso inválido produce un Error con mensaje que identifica el campo.
- No muta `spec`; función pura.

## Examples
- spec válido (name "step_1", pieceName "slack", pieceVersion "1.2.0", actionName "send_message") → no lanza
- spec con name "step-1" → lanza (must match)
- spec con pieceName "" → lanza (pieceName is required)

## Do / Don't
- DO: un `if` por cada validación, con mensaje de error específico.
- DON'T: no mutar spec, no I/O, no Date.now, no estado global.

## Tests
`src/flow-builder.test.ts` cubre spec válido y cada caso inválido (name con guion, name con espacio, pieceName/pieceVersion/actionName vacíos).

## Constraints
- PARAR y reportar si el budget no se cumple sin violar la interfaz. Sin workarounds silenciosos.