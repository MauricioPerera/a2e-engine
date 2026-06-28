# Auditoría de licencias y reutilización comercial — Activepieces

**Objetivo:** determinar qué partes del código de Activepieces son reutilizables libremente para construir un producto comercial nuevo e independiente, y cuáles no.
**Fecha:** 2026-06-27
**Repo auditado:** `D:\Repo\activepieces\activepieces`
**Método:** auditoría delegada por componentes, cada afirmación anclada a archivo:línea.

---

## TL;DR (veredicto ejecutivo)

- **No hay copyleft (GPL/LGPL/AGPL/MPL) en NINGUNA parte del grafo de producción.** Todo es MIT / Apache-2.0 / ISC / BSD / 0BSD.
- **Solo DOS rutas están bajo licencia Enterprise restrictiva** (no reutilizables sin pagar): `packages/ee/` y `packages/server/api/src/app/ee/`. Todo lo demás es **MIT Expat**.
- **Lo más limpio y "gratis"** es el **framework de pieces** (3 paquetes autocontenidos). Adóptalo tal cual.
- **El nudo de acoplamiento** es `@activepieces/shared`: motor, UI y API lo arrastran todos.
- **El server CE es la pieza más cara de reutilizar** — no por licencia, sino porque su código MIT **no compila sin el directorio `ee/`** (soldado por imports estáticos de BD).
- Trabas NO-MIT, todas identificables y removibles: el dir `ee/`, el paquete `ee-embed-sdk`, la fuente *Sentient* y el branding Activepieces.

---

## Marco de licencias (LICENSE raíz)

Según `LICENSE:5-7`:

> * Todo bajo `packages/ee/` y `packages/server/api/src/app/ee/` → **Enterprise License** (`packages/ee/LICENSE`): prohibido copiar, fusionar, publicar, distribuir, sublicenciar o vender sin licencia comercial de pago. Solo permitido para desarrollo y testing.
> * Componentes de terceros → su licencia original.
> * **Todo lo demás → "MIT Expat"** (uso comercial libre, conservando el aviso de copyright).

**Obligación MIT a cumplir siempre:** conservar el aviso `Copyright (c) 2020-2024 Activepieces Inc.` en las porciones reutilizadas. "Activepieces" es marca registrada — no transferida por el MIT.

---

## Mapa consolidado por componente

| Componente | Paquetes | Licencia | ¿Extraíble limpio? | Veredicto |
|---|---|---|---|---|
| **Framework de pieces** ⭐ | `pieces-framework`, `core-utils`, `core-piece-types` | MIT | **Sí, autocontenido** | Adoptar tal cual |
| **Motor de ejecución** | `engine` + 7 internos | MIT | Arrastra `shared` grueso, sin EE | Adoptable / o motor propio |
| **Web UI** | `web` | MIT | Sí, tras sanear 3 cosas | Adoptable tras limpieza |
| **Server CE** | `api` | MIT | **No tal cual — soldado a `ee/`** | Refactor amplio |
| **Catálogo conectores** | 720 community pieces | MIT* | Pieza por pieza (deps 3os) | Bajo demanda |

---

## 1. Framework de pieces ⭐ — VERDE TOTAL

**Conjunto:** 3 paquetes MIT, autocontenido.

```
pieces-framework  →  core-piece-types  →  core-utils  →  (nada interno)
```

- **Licencia:** MIT raíz. Fuera de toda ruta `ee/`. Sin LICENSE propio (cubierto por raíz).
- **Deps externas, 100% permisivas:** `zod` (MIT), `ai`/Vercel SDK (Apache-2.0), `semver` (ISC), `deepmerge-ts` (BSD-3), `ipaddr.js` (MIT), `nanoid` (MIT), `tslib` (0BSD).
- **Acoplamiento:** NO importa `@activepieces/shared`, `server-*` ni `ee/`. `core-piece-types` existe *deliberadamente* para evitar depender de `shared` (comentarios en el código lo confirman).
- **Qué te llevas:** `createPiece`, `createAction`, `createTrigger`, sistema de `property` (OAuth2/custom-auth, dropdowns, files), `context` de ejecución, versionado/i18n.

**Pendientes menores:** ningún `package.json` declara `"license"` (añade `"license": "MIT"` al extraer); conserva el copyright; renombra el namespace `@activepieces/*` → el tuyo.

---

## 2. Motor de ejecución — VERDE, con acoplamiento pesado

**Cierre obligatorio: 8 paquetes internos.**

```
engine → shared (GRUESO, app-level) → core-execution, core-formula, core-utils, core-piece-types
       → pieces-framework, pieces-common
```

- **Licencia:** todo MIT, cero EE, cero copyleft.
- **Deps externas notables:** `isolated-vm` (ISC), `expr-eval` (MIT), `undici` (MIT), `socket.io-client` (MIT), varios `@ai-sdk/*` (Apache-2.0). Todas permisivas.
- **Hallazgo clave:** la regla del repo (`core-packages.md`) dice *"el engine nunca debe importar `@activepieces/shared`"*, pero **en la práctica SÍ lo importa, masivamente** (~20 archivos del núcleo de ejecución). No puedes evitar arrastrar el paquete grueso `shared`.
- **Riesgos operativos (no legales):** `isolated-vm` es dependencia nativa C++ (node-gyp) → fricción de build; `worker` no está publicado a npm.

**Recomendación:** si tu producto divergirá de la arquitectura de Activepieces, evalúa escribir un motor ligero propio sobre el framework (que ya es limpio) en lugar de heredar `engine` + `shared`.

---

## 3. Web UI — VERDE, tras sanear 3 elementos

Paquete único `web` (React 19 + Vite + Tailwind 4). Editor de flujos con `@xyflow/react` (React Flow, **MIT**).

- **Licencia:** MIT raíz. Sin carpeta `ee/` interna, sin imports a `ee/` de código fuente.
- **~95 deps de producción, casi todas MIT/ISC/BSD.** Sin copyleft, sin CC-BY-NC, sin librerías UI comerciales (no AG-Grid, no Highcharts, no FullCalendar). Tiptap v3 y extensiones presentes = todas open-source MIT.

### 🔴 3 focos a eliminar antes de comercializar

| # | Qué | Dónde | Acción |
|---|---|---|---|
| 1 | **`ee-embed-sdk`** (Enterprise License) | `package.json:59` + 5 imports en UI | Eliminar/reescribir (es pequeño, solo dep `tslib`) |
| 2 | **Fuente Sentient** (Indian Type Foundry/Fontshare) | `public/fonts/Sentient-Variable.woff2`, `styles.css:8` | Verificar términos Fontshare o sustituir |
| 3 | **Branding** (marca Activepieces) | `logo.svg`, `logo-*.png`, `favicon.ico` | Reemplazar todos |

- **Acoplamiento interno (MIT, pero alto):** `@activepieces/shared` → 476 usos, `core-utils` → 265, `pieces-framework` → 43. La UI arrastra el mismo `shared` grueso que el motor.

---

## 4. Server CE — MIT, pero CE y EE están SOLDADOS

Backend `packages/server/api` (Fastify). MIT en todo lo de fuera de `ee/`. **El problema es de ingeniería, no legal.**

- **Zona EE restringida:** `packages/server/api/src/app/ee/` = **27 subcarpetas, 178 archivos** (Enterprise License).
- El registro de *features* EE sí está aislado (switch de edición en `app.ts:284`; hooks vía `.set()`). Bien diseñado.
- **PERO 38 archivos CE importan estáticamente de `ee/` (131 líneas).** Nudo crítico = capa de BD:
  - `database-connection.ts:11-29` registra **19 entidades EE** en `getEntities()`
  - `postgres-connection.ts` → **20 referencias EE** en migraciones
  - TypeORM exige registro central → **no puedes hacer `rm -rf ee/`**: el CE no transpila.
- Esto **contradice la regla del repo** (`edition-safety.md`): respetada para lógica/hooks, violada para entidades/migraciones de BD.

**Zona EE no declarada (ambigüedad legal):** `packages/server/worker/.../jobs/ee/chat/` (4 archivos) usa convención `ee/` pero NO está en las rutas que el LICENSE raíz restringe. Trátalo como restringido por prudencia; es `import()` dinámico, el worker arranca sin él.

- **Deps: limpias.** TypeORM (MIT), Fastify (MIT), BullMQ (MIT), pg (MIT), pglite (Apache-2.0). Sin copyleft. Deps "comerciales" (Stripe, 1Password SDK, samlify/SAML) **confinadas en `ee/`** → no contaminan el CE.
- **Coste de extraer CE limpio:** refactor mecánico pero amplio — quitar entidades/migraciones EE de `getEntities()`/`getMigrations()` + parchear ~36 services CE que tipan contra símbolos EE.

---

## 5. Catálogo de 720 conectores — pendiente, bajo demanda

`packages/pieces/community/` (720 pieces). MIT a nivel Activepieces, **pero el riesgo real está en las dependencias de terceros de cada pieza** (SDKs con licencias propias) y en marcas/logos de cada servicio. Se audita **pieza por pieza** solo cuando se elija cuáles copiar.

---

## Conclusiones estratégicas

1. **Lo verdaderamente gratis y limpio** es el **framework de pieces** + sus 2 core. Cero fricción.
2. **`@activepieces/shared`** es el nudo que ata motor, UI y API. Todo lo que reutilices más allá del framework lo arrastra.
3. **Cero riesgo de copyleft en todo el proyecto.** Las únicas trabas NO-MIT son: el dir `ee/`, `ee-embed-sdk`, la fuente Sentient y el branding — todas identificables y removibles.
4. **El server es la pieza más cara de reutilizar** — no por licencia, sino porque el CE no transpila sin el EE.
5. **Camino recomendado para "algo nuevo y tuyo":** backend propio + framework de pieces de Activepieces (y, opcionalmente, conectores concretos auditados uno a uno), en lugar de heredar la API/engine completos.

## Checklist legal antes de shippear
- [ ] Conservar aviso `Copyright (c) Activepieces Inc.` en porciones MIT reutilizadas.
- [ ] Añadir `"license": "MIT"` explícito a los `package.json` extraídos.
- [ ] Renombrar namespace `@activepieces/*` → el tuyo (marca).
- [ ] Eliminar `ee-embed-sdk` y cualquier import a rutas `ee/`.
- [ ] Sustituir/licenciar la fuente Sentient.
- [ ] Reemplazar todos los assets de marca (logos, favicon).
- [ ] Auditar deps de terceros de cada pieza del catálogo que se copie.
- [ ] (Opcional) Escaneo SCA (ScanCode/FOSSA) sobre el build para garantía legal documental.
