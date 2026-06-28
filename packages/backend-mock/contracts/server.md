---
task: engine-backend-server
intent: Construir un http.Server que enruta las 7 rutas del engine-backend-mock contra vault/store/files reales.
target: D:/Repo/activepieces/engine-backend-mock/src/server.ts
language: typescript
kind: function
signature: "def createServer(deps)"
tests: D:/Repo/activepieces/engine-backend-mock/src/server.test.ts
test_command: "cmd /c npx tsx --test server.test.ts"
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
`createServer(deps)` devuelve un `http.Server` (NO llama listen) cuyo handler enruta las 7 rutas
del engine. Modular: cada handler en su propia funcion pequena, todas bajo el budget firmado
(cyclomatic<=5, nesting<=2, params<=3, lines<=20). El gate mide cada funcion; si alguna excede,
subdividir. Solo `node:http`, `node:url`, `node:buffer`. Sin Express ni dependencias externas.

## Interface (exportada, NO cambiar)
- `createServer(deps: { vault: Vault; store: MemoryStore; files: MemoryFileStore; engineToken: string; project: { id: string; externalId: string } }): http.Server`
- Imports reales: `import { Vault } from './vault.js'`, `import { MemoryStore } from './store.js'`, `import { MemoryFileStore } from './files.js'`. (El repo es CommonJS con tsx; usar extension `.js` en los imports nombrados, como hacen los tests.)
- NO llamar `listen` dentro de createServer; solo construir y devolver el `http.Server`.

## Rutas (contrato verificado, NO cambiar — el engine construye URLs con apiUrl que termina en `/`)
- `GET /v1/worker/app-connections/<externalId>?projectId=<p>` -> 200 con el AppConnection JSON
  (`vault.obtain(projectId, externalId)`). Si devuelve `null` -> 404. Requiere `Authorization: Bearer <engineToken>`.
- `GET /v1/store-entries?key=<k>` -> 200 con el StoreEntry JSON, o 200 con `null` si no existe.
  Requiere Bearer.
- `POST /v1/store-entries` body JSON `{ key, value }` -> 200 con el StoreEntry guardado
  (`store.put(key, value)`). Requiere Bearer.
- `DELETE /v1/store-entries?key=<k>` -> 200 idempotente (`store.delete(key)`). Requiere Bearer.
- `GET /v1/worker/project` -> 200 con `{ id, externalId }` (de `deps.project`). SIN auth.
- `PUT /v1/files/<fileId>?token=<t>` -> 200; el body son los BYTES del archivo (`files.put(fileId, Buffer.from(body))`). Credencial en query `token` (debe igualar `engineToken`); si no -> 401.
- `GET /v1/files/<fileId>?token=<t>` -> 200 con los bytes (Content-Type `application/octet-stream`),
  o 404 si no existe. Credencial en query `token`; si no -> 401.

## Autenticacion
- Connections y store: header `Authorization: Bearer <engineToken>`. Ausente o distinto -> 401.
- Files: query `?token=<engineToken>`. Ausente o distinto -> 401.
- `GET /v1/worker/project`: NO requiere auth.

## Respuestas
- JSON: Content-Type `application/json; charset=utf-8`, body `JSON.stringify(obj)`.
- Bytes: Content-Type `application/octet-stream`, body `Buffer`.
- 404 / 401 / 200 sin cuerpo explicito: res.writeHead(status, {...}) + res.end() (cuerpo vacio o JSON chico). Los tests solo chequean status en esos casos (excepto 200 con JSON/bytes).
- Para `null` (store inexistente): 200 con body `null` (JSON.stringify(null) = 'null'), Content-Type JSON.

## Descomposicion modular REQUERIDA (cada funcion bajo budget; el gate mide cada una)
Descomponer para mantener cyclomatic<=5, nesting<=2, params<=3, lines<=20. Estructura sugerida
(el implementador puede ajustar nombres pero debe respetar el budget en CADA funcion):

- `createServer(deps)`: crea `http.createServer((req,res) => handleRequest(req, res, deps))` y lo devuelve. cyclomatic 1.
- `handleRequest(req, res, deps)`: parsea URL con `new URL(req.url, 'http://localhost')`, arma `ctx = { req, res, deps, pathname, query }`, despacha por metodo dentro de un try/catch (catch -> 500 JSON). 3 params.
- `dispatch(ctx)`: segun `ctx.req.method` elige `routeGet/routePost/routeDelete/routePut`; default -> `notFound(ctx)`. Usar if/return encadenado o un Map. 1 param (ctx).
- `routeGet(ctx)`: matchea pathname: `/v1/worker/app-connections/<id>` -> handleGetConnection; `/v1/store-entries` -> handleGetStore; `/v1/worker/project` -> handleGetProject; `/v1/files/<id>` -> handleGetFile; else notFound. 1 param.
- `routePost(ctx)`: `/v1/store-entries` -> handlePostStore; else notFound. 1 param.
- `routeDelete(ctx)`: `/v1/store-entries` -> handleDeleteStore; else notFound. 1 param.
- `routePut(ctx)`: `/v1/files/<id>` -> handlePutFile; else notFound. 1 param.
- `handleGetConnection(ctx)`: si `!requireBearerAuth(ctx)` return; `vault.obtain(query.projectId, externalId)`; null -> 404; sino 200 JSON. 1 param.
- `handleGetStore(ctx)`: si `!requireBearerAuth(ctx)` return; `store.get(query.key)`; 200 JSON (entry o null). 1 param.
- `handlePostStore(ctx)`: si `!requireBearerAuth(ctx)` return; leer body JSON; `store.put(key, value)`; 200 JSON. 1 param. (readBody como helper async.)
- `handleDeleteStore(ctx)`: si `!requireBearerAuth(ctx)` return; `store.delete(query.key)`; 200. 1 param.
- `handleGetProject(ctx)`: 200 JSON con `deps.project`. 1 param. (Sin auth.)
- `handlePutFile(ctx)`: si `!requireTokenAuth(ctx)` return; leer body bytes; `files.put(fileId, Buffer.from(body))`; 200. 1 param.
- `handleGetFile(ctx)`: si `!requireTokenAuth(ctx)` return; `files.get(fileId)`; null -> 404; sino 200 bytes. 1 param.
- `requireBearerAuth(ctx)`: compara `ctx.req.headers.authorization` con `Bearer ${ctx.deps.engineToken}`; si no coincide, `sendJson(ctx, 401, { error: 'unauthorized' })` y devuelve false; sino true. 1 param.
- `requireTokenAuth(ctx)`: compara `ctx.query.token` con `ctx.deps.engineToken`; si no, 401 y false; sino true. 1 param.
- `sendJson(ctx, status, obj)`: writeHead(status, {'content-type':'application/json; charset=utf-8'}); end(JSON.stringify(obj)). 3 params.
- `sendBytes(ctx, status, buf)`: writeHead(status, {'content-type':'application/octet-stream'}); end(buf). 3 params.
- `notFound(ctx)`: sendJson(ctx, 404, { error: 'not found' }). 1 param.
- `readBody(ctx): Promise<Buffer>`: lee los chunks de `ctx.req` y los concatena en un Buffer. 1 param.

## Invariants
- createServer NO llama listen (lo hacen los tests con server.listen(0)).
- Sin dependencias externas; solo `node:http`, `node:url`, `node:buffer` y los 3 modulos del repo.
- Las rutas son EXACTAS (no agregar prefijos ni quitarlos). Pathname se toma de la URL parseada.
- `externalId`/`fileId` se extraen del pathname (segmento tras el prefijo de ruta).
- El body de POST store es JSON; el body de PUT files son bytes crudos.
- 401 NO filtra si el token existe o no (mismo 401).
- project NO requiere auth.

## Examples
- `createServer(deps)` devuelve un `http.Server` con `.listen`/`.close` disponibles.
- GET connection existente con Bearer correcto -> 200 JSON con `value.secret_text`.
- GET connection con Bearer incorrecto -> 401.
- POST store {key:'k', value:{x:1}} -> 200 {key:'k', value:{x:1}}; GET mismo -> 200 igual.
- DELETE store -> 200; GET mismo -> 200 null.
- PUT files con token correcto -> 200; GET mismo -> 200 bytes iguales.
- GET files inexistente -> 404.

## Do / Don't
- Do: parsear URL con `new URL(req.url, 'http://localhost')` para obtener pathname y searchParams.
- Do: cada handler en su propia funcion; pasar un objeto `ctx` para mantener params<=3.
- Do: usar `node:buffer` Buffer para los bytes de files.
- Do: importar los 3 modulos con extension `.js` (Convencion tsx/CommonJS del repo).
- Don't: no usar Express ni ninguna dependencia externa.
- Don't: no llamar listen dentro de createServer.
- Don't: no anidar mas de 2 niveles; preferir early return.
- Don't: no mezclar auth de Bearer (connections/store) con auth de token query (files).

## Tests
Tests congelados en `src/server.test.ts` (node:test + node:assert/strict) cubren: connection
encontrada->200 con value, no encontrada->404, sin Bearer->401, token equivocado->401, store
POST->GET round-trip, store GET inexistente->200 null, store DELETE idempotente, store sin
Bearer->401, worker/project->200, files PUT->GET round-trip bytes, files GET inexistente->404,
files PUT/GET con token equivocado->401. Oraculo independiente: arranca el server con
`server.listen(0)`, hace fetch real a cada ruta; los valores esperados son literales.

## Constraints
- Sin dependencias externas; solo `node:http`, `node:url`, `node:buffer` y los 3 modulos del repo.
- Preservar el estilo del repo (mirar src/store.ts, src/files.ts): funciones cortas, JSDoc breve, imports nombrados.
- PARAR y reportar si alguna funcion supera el budget (cyclomatic>5, nesting>2, params>3, lines>20).
  Si alguna lo supera, subdividirla en funciones puras mas chicas y delegar esas por separado.