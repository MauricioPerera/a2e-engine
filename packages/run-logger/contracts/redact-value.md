---
task: redact-value
intent: Serializar un valor a string seguro truncando si excede maxLen.
target: src/run-logger.ts
kind: function
language: typescript
signature: "def redactValue(value, maxLen=2000)"
test_command: npx tsx --test redact-value.test.ts
deps_allowed: []
tests: src/redact-value.test.ts
budget:
  cyclomatic: 10
  nesting: 3
  params: 4
  lines: 40
---

## Intent
Convertir cualquier valor de entrada en un string seguro para logs/redaccion, truncando payloads largos.

## Interface
`redactValue(value: unknown, maxLen = 2000): string`

## Invariants
- `undefined` -> `"undefined"` (string literal).
- string -> tal cual.
- resto -> `JSON.stringify(value)`; si lanza -> `"[unserializable]"`.
- si el resultado excede `maxLen` -> `s.slice(0, maxLen) + "… [truncated N chars]"` donde N = `s.length - maxLen`.
- NUNCA lanza.

## Examples
- `redactValue(undefined)` -> `"undefined"`
- `redactValue("hola")` -> `"hola"`
- `redactValue({a:1})` -> `{"a":1}`
- `redactValue("x".repeat(5000), 100)` -> termina en `… [truncated 4900 chars]`
- objeto circular -> `"[unserializable]"`

## Do / Don't
- DO: envolver `JSON.stringify` en try/catch.
- DON'T: usar `Date`, FS, red.
- DON'T: lanzar.

## Tests
Oraculo congelado (node:test + node:assert) independiente del target.

## Constraints
- Budget: cyclomatic<=10, nesting<=3, params<=4, lines<=40.
- PARAR y reportar si no se puede evitar lanzar con circulares dentro de budget.