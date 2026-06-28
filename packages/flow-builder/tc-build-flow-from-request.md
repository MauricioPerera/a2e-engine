---
task: build-flow-from-request
intent: "Build the chained PieceAction flow from an ExecuteRequest."
target: src/flow-builder.ts
signature: "def buildFlowFromRequest(req: ExecuteRequest, lastUpdatedDate: string) -> PieceAction"
budget: { cyclomatic_max: 6, nesting_max: 3, params_max: 2, lines_max: 30 }
deps_allowed: []
forbids: ["Date.now", "I/O", "estado global", "mutar el input del step original"]
language: typescript
tests: src/build-from-request.test.ts
test_command: "cmd /c npx tsx --test build-from-request.test.ts"
depends_on: ["connectionRef", "buildPieceStep", "chainSteps", "StepSpec", "PieceAction"]
spec_version: "0.1"
sign: true
---

## Intent
Validar un `ExecuteRequest` del agente y construir el `PieceAction` encadenado que el engine ejecuta, reutilizando las funciones puras existentes del módulo.

## Interface
```
in:  req: ExecuteRequest { steps: Array<{ name, displayName?, pieceName, pieceVersion,
        actionName, input?, connection?: { name, property? } }> },
      lastUpdatedDate: string (ISO, pasado por parámetro)
out: PieceAction (la cabeza de la cadena nextAction; nunca null porque steps es no vacío)
error: lanza Error("request must have at least one step") si req.steps no es array no vacío;
       propaga los errores de buildPieceStep/validateStepSpec para steps inválidos
```

## Invariants
- `req.steps` vacío o ausente => lanza `Error("request must have at least one step")`.
- Para cada step, `input` por defecto es `{}` cuando el step no trae `input`.
- Si el step trae `connection`, se inyecta `connectionRef(connection.name)` en
  `input[connection.property ?? "auth"]`, preservando las demás keys de `input`.
- La referencia inyectada es el string literal `{{connections['<name>']}}` (no se expande el secreto).
- Cada step se construye con `buildPieceStep` (que valida el spec) y se encadena con `chainSteps`.
- El valor devuelto es la cabeza de la cadena; `nextAction` sigue el orden de `req.steps`;
  el último nodo tiene `nextAction === undefined`.
- `lastUpdatedDate` viene del parámetro (sin `Date.now` interno).
- No muta el `input` original del step (construye una copia para inyectar la conexión).
- No rompe exports previos del módulo.

## Examples
- `{ steps: [] }` con date D => lanza /at least one step/
- `{ steps: [{ name:"s1", pieceName:"slack", pieceVersion:"1.2.0", actionName:"send_message", input:{ channel:"#general" } }] }` => head.settings.input == { channel:"#general" }, head.nextAction === undefined
- step sin `input` => head.settings.input == {}
- step con `connection:{ name:"slack" }` => head.settings.input.auth == "{{connections['slack']}}"
- step con `connection:{ name:"slack", property:"token" }` => head.settings.input.token == "{{connections['slack']}}", input.auth === undefined
- 2 steps [s1, s2] => head.name == "s1", head.nextAction.name == "s2", head.nextAction.nextAction === undefined

## Do / Don't
- DO: validar array no vacío primero; clonar `input` antes de inyectar; delegar a `buildPieceStep` y `chainSteps`.
- DON'T: no usar `Date.now`, no mutar el input original del step, no expandir la referencia, no I/O, no estado global, no romper exports existentes.

## Tests
`src/build-from-request.test.ts` cubre: steps vacío/undefined lanza; 1 step sin connection deja input intacto (y default `{}`); inyección en `auth`; inyección en `property` custom; encadenamiento de 2 steps en orden; preservación del string de referencia sin expandir; encadenamiento de N steps en orden con semilla fija. Oráculo independiente: define sus propios valores esperados, no importa constantes del target.

## Constraints
- PARAR y reportar si el budget no se cumple sin violar la interfaz. Sin workarounds silenciosos.
- Si la función excede el budget, subdividirla en helpers (cada uno con su contrato + tests) antes de inflar el budget.