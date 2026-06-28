---
task: vault-credential-store
intent: Almacenar credenciales cifradas en reposo con AES-256-GCM, aisladas por projectId.
target: ../src/vault.ts
language: typescript
signature: "put(params: object): void"
tests: ../src/vault.test.ts
test_command: "cmd /c npx tsx --test vault.test.ts"
deps_allowed: []
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
Almacen de credenciales cifradas en reposo (AES-256-GCM), aisladas por projectId. Expone la clase
Vault con put/obtain/listReferences y un audit log interno que registra toda desreferencia. El
unico punto donde un secreto se descifra es `obtain()`.

## Interface (exportada, NO cambiar — la consume el engine)
- `AppConnectionType = 'SECRET_TEXT' | 'BASIC_AUTH' | 'CUSTOM_AUTH' | 'OAUTH2' | 'NO_AUTH'`
- `AppConnectionValue` =
    | { type: 'SECRET_TEXT'; secret_text: string }
    | { type: 'BASIC_AUTH'; username: string; password: string }
    | { type: 'CUSTOM_AUTH'; props: Record<string, unknown> }
    | { type: 'NO_AUTH' }
- `AppConnection = { externalId: string; type: AppConnectionType; pieceName: string; displayName: string; projectIds: string[]; status: 'ACTIVE' | 'MISSING' | 'ERROR'; value: AppConnectionValue }`
- `AuditEntry = { at: string; externalId: string; projectId: string; ok: boolean }`
- `EncryptedRecord = { externalId: string; projectId: string; type: AppConnectionType; pieceName: string; displayName: string; ciphertext: string }`
- `class Vault`:
  - `constructor(masterKey: string)` — deriva clave con `scryptSync(masterKey, 'okf-motor-vault-salt', 32)`; lanza `Error` si `masterKey` es falsy o `masterKey.length < 16`.
  - `put(params: object): void` donde `params = { externalId: string; projectId: string; pieceName: string; displayName: string; value: AppConnectionValue }`. Serializa `value` a JSON, cifra con AES-256-GCM (IV aleatorio de 12 bytes por registro, authTag guardado), guarda un `EncryptedRecord` en `this.records` bajo la clave compuesta `${projectId}::${externalId}`. Reemplaza si la clave ya existe. El parametro se llama `params` (un unico parametro objeto, NO destructuracion sin nombre).
  - `obtain(projectId: string, externalId: string): AppConnection | null` — busca el registro por clave compuesta; SIEMPRE pusha una entrada en `this.audit` con `{ at: new Date().toISOString(), externalId, projectId, ok }` donde `ok` = se encontro el registro. Si no existe, devuelve `null`. Si existe, devuelve `AppConnection` con `projectIds: [projectId]`, `status: 'ACTIVE'`, `type`/`pieceName`/`displayName` del registro y `value` descifrado.
  - `listReferences(projectId: string): Array<{ externalId: string; displayName: string; pieceName: string; type: AppConnectionType }>` — solo los registros cuyo `projectId` coincide; NUNCA expone el value ni el ciphertext.
  - propiedad publica `readonly audit: AuditEntry[]`.

## Estructura interna (REQUERIDA — los tests congelados la inspeccionan)
- Campo `private records: Map<string, EncryptedRecord>`.
- Campo `private readonly key: Buffer` (32 bytes derivados por scrypt).
- `ciphertext` es el string `${iv.toString('hex')}:${authTag.toString('hex')}:${data.toString('hex')}` (todo hex, separado por `:`).
- Metodos privados: `recordKey(projectId, externalId): string` (`${projectId}::${externalId}`), `encrypt(value: AppConnectionValue): string`, `decrypt(ciphertext: string): AppConnectionValue`.
- Usar `node:crypto`: `createCipheriv`, `createDecipheriv`, `randomBytes`, `scryptSync`. Algoritmo `'aes-256-gcm'`. IV de 12 bytes. `setAuthTag`/`getAuthTag`.

## Invariants
- Aislamiento por projectId es OBLIGATORIO: `obtain(p2, e)` de un registro guardado en `p1` devuelve `null` (clave compuesta, no prefijo).
- `obtain` registra en `audit` SIEMPRE, exista o no el registro (`ok` refleja existencia).
- El ciphertext almacenado y los objetos devueltos por `listReferences` NO contienen el secreto en claro.
- IV aleatorio por registro: dos `put` del mismo value producen ciphertext distinto.
- `constructor` con masterKey de < 16 chars (o vacio) lanza; NO deriva clave en ese caso.
- Solo stdlib de Node (`node:crypto`); sin dependencias externas.
- `put` recibe un unico parametro objeto llamado `params` (no destructuracion sin nombre).

## Examples
- `new Vault('k'.repeat(16))` no lanza; `new Vault('short')` lanza; `new Vault('')` lanza.
- put SECRET_TEXT 'hunter2' en p1; `obtain('p1','c1').value.secret_text === 'hunter2'`, `.status === 'ACTIVE'`, `.projectIds` === `['p1']`.
- put en p1; `obtain('p2','c1') === null`; ultima entrada `audit` tiene `ok:false`, `projectId:'p2'`.
- `obtain('p1','missing') === null`; ultima entrada `audit` tiene `ok:false`.
- `listReferences('p1')` NO contiene la subcadena `'hunter2'` ni `'pass123'` al serializarlo.
- El `ciphertext` de cada registro en `records` NO contiene la subcadena del secreto en claro.

## Do / Don't
- Do: AES-256-GCM con authTag guardado y verificado en decrypt.
- Do: clave compuesta `${projectId}::${externalId}` para aislar por proyecto.
- Do: parametro `params` con nombre (no destructuracion anonima en la firma de put).
- Don't: no devolver nunca el value desde `listReferences`.
- Don't: no usar prefijo de projectId para aislar (usa clave compuesta exacta).
- Don't: no usar dependencias externas; solo `node:crypto`.
- Don't: no usar campos `#private` (los tests inspeccionan `records` en runtime via cast); usa `private` de TS.

## Tests
Tests congelados en `src/vault.test.ts` (node:test + node:assert/strict) cubren: round-trip
put/obtain de los 4 tipos de value; aislamiento por projectId (obtain de otro projectId => null);
obtain de inexistente => null y deja audit ok:false; obtain existente deja audit ok:true;
masterKey < 16 chars lanza (y vacio lanza); listReferences no expone el secreto; el ciphertext
almacenado (inspeccionado via `(vault as any).records`) no contiene el secreto en claro; IV
aleatorio (dos put del mismo value => ciphertext distinto). Oraculo independiente: los secretos
esperados ('hunter2', 'pass123', etc.) son literales en el test, no derivados de la logica del vault.

## Constraints
- Sin dependencias externas; solo `node:crypto` (stdlib).
- Preservar el estilo del repo (ver src/vault.ts previo y contracts/store.md): clase con campos
  Map privados, metodos cortos, JSDoc breve, imports nombrados de `node:crypto`.
- PARAR y reportar si alguna funcion supera el budget (cyclomatic>5, nesting>2, params>3, lines>20).
  Si alguna lo supera, subdividir encrypt/decrypt/deriveKey en funciones puras mas chicas y delegar
  esas por separado.