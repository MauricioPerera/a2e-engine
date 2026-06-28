---
task: connection-ref
intent: "Build the connection reference string for a credential name."
target: src/flow-builder.ts
signature: "def connectionRef(name: string) -> string"
budget: { cyclomatic_max: 3, nesting_max: 2, lines_max: 10, params_max: 1 }
deps_allowed: []
forbids: ["Date.now", "I/O", "estado global"]
language: typescript
tests: src/flow-builder.test.ts
test_command: "cmd /c npx tsx --test flow-builder.test.ts"
spec_version: "0.1"
sign: true
---

## Intent
Devolver `{{connections['<name>']}}` para referenciar una credencial por nombre sin exponer el secreto.

## Interface
```
in:  name: string (no vacío)
out: string exacto `{{connections['<name>']}}`
error: lanza Error("connectionRef: name is required") si name es vacío
```

## Invariants
- El formato es literalmente `{{connections['<name>']}}` con el nombre interpolado.
- Función pura: sin I/O, sin estado, sin Date.now.

## Examples
- `connectionRef("slack")` → `{{connections['slack']}}`
- `connectionRef("my_conn_2")` → `{{connections['my_conn_2']}}`

## Do / Don't
- DO: template literal con el nombre interpolado.
- DON'T: no usar Date.now, no I/O, no estado global.

## Tests
`src/flow-builder.test.ts` cubre el formato exacto y el throw cuando name es vacío.

## Constraints
- PARAR y reportar si el budget no se cumple sin violar la interfaz. Sin workarounds silenciosos.