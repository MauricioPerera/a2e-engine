# engine-backend-mock

Mock del **backend interno del engine de Activepieces**. Reproduce, en proceso y
sin dependencias externas, las rutas del worker que el engine consume durante la
ejecución de piezas: conexiones de aplicación (vault cifrado), entradas de
key/value store y blobs de archivos. Es un artefacto autónomo y arrancable,
pensado para desarrollo y pruebas locales del flujo del engine sin levantar el
monorepo completo de Activepieces.

## Estado

**Fase 1 — sin OAuth2.** El modelo de credenciales soporta `SECRET_TEXT`,
`CUSTOM_AUTH` y `NO_AUTH` (los tipos `BASIC_AUTH` y `OAUTH2` están definidos en el
vault pero no se siembran ni se ejercitan todavía). El endpoint e2e contra el
engine **real** (Activepieces) queda fuera de este componente: requiere construir
el monorepo de Activepieces y arrancar su engine; es trabajo pendiente.

## Componentes

| Archivo | Rol |
| --- | --- |
| `src/vault.ts` | `Vault`: almacén cifrado (AES-256-GCM) de credenciales por proyecto + externalId, con auditoría y listado de referencias. |
| `src/store.ts` | `MemoryStore`: key/value store en memoria. |
| `src/files.ts` | `MemoryFileStore`: blobs de archivos en memoria. |
| `src/server.ts` | `createServer(deps)`: servidor HTTP (NO hace `listen`). |
| `src/seed.ts` | `seedVault(vault, projectId)`: carga credenciales demo. |
| `src/main.ts` | Punto de entrada arrancable (el único que hace `listen`). |
| `src/smoke.test.ts` | Test de humo e2e con `node:test` + `fetch` real. |

## Rutas (7)

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| `GET` | `/v1/worker/project` | — | Devuelve `{ id, externalId }` del proyecto configurado. |
| `GET` | `/v1/worker/app-connections/:externalId?projectId=` | `Bearer <engineToken>` | Obtiene la conexión del vault (404 si no existe). |
| `GET` | `/v1/store-entries?key=` | `Bearer <engineToken>` | Lee una entrada del store. |
| `POST` | `/v1/store-entries` | `Bearer <engineToken>` | Crea/reemplaza una entrada `{ key, value }`. |
| `DELETE` | `/v1/store-entries?key=` | `Bearer <engineToken>` | Borra una entrada (idempotente). |
| `PUT` | `/v1/files/:fileId?token=` | `?token=<engineToken>` | Guarda bytes de un archivo. |
| `GET` | `/v1/files/:fileId?token=` | `?token=<engineToken>` | Devuelve los bytes del archivo (404 si no existe). |

> El worker usa `Bearer` en cabecera para conexiones/store y `token` en query
> para archivos, tal como hace el engine real.

## Cómo arrancar

```bash
npx tsx src/main.ts
```

Imprime `engine-backend-mock listening on http://localhost:<PORT>`.

## Variables de entorno (con defaults)

| Var | Default | Uso |
| --- | --- | --- |
| `AP_ENGINE_TOKEN` | `dev-engine-token` | Token que valida las llamadas del worker (Bearer / `?token=`). |
| `PORT` | `3000` | Puerto de escucha. |
| `VAULT_MASTER_KEY` | `dev-master-key-16chars` | Clave maestra del vault (≥ 16 chars). |
| `PROJECT_ID` | `demo-project` | ID interno del proyecto. |
| `PROJECT_EXTERNAL_ID` | `demo-ext` | externalId expuesto por `/v1/worker/project`. |

## Tests

```bash
# solo humo
npx tsx --test src/smoke.test.ts

# suite completa
npx tsx --test src/*.test.ts
```

## Modelo de credenciales

Las credenciales se guardan **cifradas** en el `Vault` (AES-256-GCM derivado de la
master key vía `scrypt`), indexadas por `(projectId, externalId)`. El engine, al
ejecutar una pieza, resuelve la referencia `{{connections.<externalId>}}` llamando
a `/v1/worker/app-connections/<externalId>`; el vault descifra y devuelve el
`value`. El agente/pieza consume el valor ya materializado, pero el secreto **no
se loguea** ni se persiste en claro fuera del vault cifrado, y el listado
(`/listReferences`) expone solo metadatos (`externalId`, `displayName`,
`pieceName`, `type`), nunca el valor. Así el agente nunca ve secretos en texto
plano fuera del canal cifrado de resolución.