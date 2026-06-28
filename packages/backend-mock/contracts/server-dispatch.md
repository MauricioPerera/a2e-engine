---
task: server-dispatch
intent: Reducir la ciclomatica de dispatch a <=5 refactorizando el switch a tabla de despacho.
target: D:/Repo/activepieces/engine-backend-mock/src/server.ts
language: typescript
kind: function
signature: "def dispatch(ctx)"
tests: D:/Repo/activepieces/engine-backend-mock/src/server-dispatch.test.ts
test_command: "cmd /c npx tsx --test server.test.ts server-dispatch.test.ts"
deps_allowed: ["node:http", "node:url", "node:buffer"]
forbids:
  - eval
  - Function
budget:
  cyclomatic: 5
  nesting: 2
  params: 3
  lines: 20
---

## Intent
`dispatch(ctx)` despacha la peticion al sub-router por metodo HTTP. Hoy usa un `switch` con 4 cases
+ default => ciclomatica 6, que EXCEDE el budget firmado (5). Refactorizar a una tabla de despacho
(Map de metodo -> sub-router) con fallback, para bajar ciclomatica a <=2. Ademas EXPORTAR dispatch
(los tests unitarios la importan). El resto del archivo NO debe modificarse (las demas funciones ya
pasan el budget; los tests congelados deben seguir en verde).

## Interface
- `export async function dispatch(ctx: RequestContext): Promise<void>` — EXPORTADA, misma firma y comportamiento.
- Selecciona el sub-router segun `ctx.req.method`:
  - GET -> routeGet, POST -> routePost, PUT -> routePut, DELETE -> routeDelete.
  - metodo desconocido -> notFound(ctx).
- Ejemplo: `const routes = new Map([...]); const r = routes.get(ctx.req.method ?? ''); return r ? r(ctx) : notFound(ctx);`

## Invariants
- Comportamiento identico: mismo mapeo metodo->sub-router, mismo fallback a notFound.
- EXPORTAR dispatch (los tests unitarios `server-dispatch.test.ts` la importan).
- No modificar createServer, handleRequest, routeGet/Post/Delete/Put, los handlers, auth, send*, readBody (salvo agregar `export` solo a dispatch).
- `server.test.ts` (13 tests HTTP) Y `server-dispatch.test.ts` (5 tests unitarios) deben pasar todos.
- ciclomatica de dispatch <= 5 (objetivo <= 2 via tabla de despacho).

## Examples
- dispatch GET /v1/worker/project -> 200 con project.
- dispatch POST /v1/store-entries sin Bearer -> 401.
- dispatch 'FOO' -> 404.

## Do / Don't
- Do: usar un `Map<string, (ctx) => Promise<void>>` de metodo -> sub-router y un fallback.
- Do: `export async function dispatch(...)`.
- Don't: no usar switch (sube ciclomatica a 6).
- Don't: no modificar otras funciones del archivo (salvo el `export` en dispatch).
- Don't: no cambiar la firma ni el comportamiento observable.

## Tests
Tests congelados en `src/server-dispatch.test.ts` (node:test + node:assert/strict) importan `dispatch`
y cubren el ruteo por metodo (GET->routeGet, POST->routePost, DELETE->routeDelete, PUT->routePut) y
el fallback a notFound, con deps stub y un mock res que captura status/body. Oraculo independiente.
Ademas `src/server.test.ts` (HTTP end-to-end) debe seguir 13/13 verde.

## Constraints
- Solo `node:http`, `node:url`, `node:buffer` y los modulos del repo.
- PARAR si cyclomatic>5, nesting>2, params>3, lines>20.