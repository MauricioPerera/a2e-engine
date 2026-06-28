# SCA-Lite: Reporte automatizado de licencias

Fecha: 2026-06-28
Repo: `~/product` (github.com/MauricioPerera/a2e-engine)
Herramienta: `license-checker` v25.0.1 (`npx license-checker@latest`)
Complementa: `DEP-AUDIT.md` (auditoria manual de pieces, 2026-06-27)

---

## 1. Resumen del escaneo automatico (`license-checker --summary`)

Salida real de `npx license-checker@latest --summary` sobre `~/product`:

```
├─ MIT: 5
├─ UNLICENSED: 4
├─ ISC: 1
└─ Apache-2.0: 1
```

**Total de paquetes escaneados (arbol `~/product/node_modules`): 11**

| Licencia | # | Paquetes |
| --- | --- | --- |
| MIT | 5 | `@esbuild/linux-x64@0.28.1`, `@types/node@26.0.1`, `esbuild@0.28.1`, `tsx@4.22.4`, `undici-types@8.3.0` |
| Apache-2.0 | 1 | `typescript@5.9.3` |
| ISC | 1 | `engine-backend-mock@1.0.0` (propio, workspace) |
| UNLICENSED | 4 | `flow-builder@0.1.0`, `okf-generator@0.1.0`, `product@0.0.0`, `trigger-runtime@0.1.0` (propios, workspace) |

> **Nota sobre los 4 "UNLICENSED":** son los **propios packages privados** del workspace (`product`, `flow-builder`, `okf-generator`, `trigger-runtime`) cuyo `package.json` no declara campo `license`. No son dependencias de terceros. Para uso interno/private es esperado; si se publican, conviene agregar `license: MIT`. **No es un hallazgo de copyleft.**

### Por que solo 11 paquetes

El repo `~/product` es un workspace npm con deps minimas: la toolchain de build
(esbuild, tsx, typescript, @types/node, undici-types). El `package-lock.json`
tiene 43 entradas (todas `@esbuild/*` por plataforma + las anteriores + los
symlinks de los 5 packages). **No hay `node_modules` dentro de `packages/*`**:
las deps de runtime del engine y de las pieces NO estan instaladas en
`~/product`; se inlinean en `engine.cjs` y en los bundles de pieces desde el
arbol externo `~/ap` (Activepieces, MIT) durante el build con esbuild. Por eso
el escaneo de `license-checker` sobre `~/product` refleja solo la toolchain, y
las deps de produccion se verifican por separado en la seccion 2.

---

## 2. Dependencias de produccion del engine y pieces (no instaladas en ~/product)

Estas deps se bundlean en `engine.cjs` / pieces desde `~/ap`. Licencias
verificadas con `npm view <pkg> license` (2026-06-28):

### Engine / Activepieces empaquetadas

| Paquete | Licencia | Permisiva |
| --- | --- | --- |
| zod | MIT | si |
| ai (Vercel AI SDK) | Apache-2.0 | si |
| dayjs | MIT | si |
| expr-eval | MIT | si |
| nanoid | MIT | si |
| semver | ISC | si |
| socket.io-client | MIT | si |
| isolated-vm (external) | ISC | si |
| undici | MIT | si |
| deepmerge-ts | BSD-3-Clause | si |
| ipaddr.js | MIT | si |
| tslib | 0BSD | si |

### Externals de los bundles de pieces (echo/hook)

| Paquete | Licencia | Permisiva |
| --- | --- | --- |
| isolated-vm | ISC | si |
| utf-8-validate | MIT | si |
| bufferutil | MIT | si |

### Pieces demo

| Piece | Dep externa | Licencia | Permisiva |
| --- | --- | --- | --- |
| json (`@activepieces/piece-json`) | jsonata | MIT | si |
| echo (`@automators/piece-echo-auth`, propia) | (ninguna) | - | si |
| tick (`@automators/piece-tick`, propia) | (ninguna) | - | si |
| hook (`@automators/piece-hook`, propia) | (ninguna; solo externals del engine) | - | si |

Confirmado: echo, tick y hook son pieces propias y no aportan deps de
aplicacion externas (sus bundles solo marcan como `external` a
`isolated-vm`, `utf-8-validate`, `bufferutil` — todas permisivas, ver tabla
superior). json usa `jsonata` (MIT).

### Community pieces en el arbol (catalogo)

El repo incluye `community-pieces` (airtable 0.6.9, flow-helper 0.1.4,
github 0.8.3, slack 0.17.2) como muestras de catalogo. Sus deps externas
estan auditadas en `DEP-AUDIT.md` (todas MIT: airtable, dayjs, jsonwebtoken,
@slack/web-api, slackify-markdown, zod, jsonata). Sin copyleft.

---

## 3. Paquetes con licencia NO permisiva

**Ninguno.** No se encontro ningun paquete con licencia copyleft
(GPL / LGPL / AGPL / MPL), dual, custom ni comercial — ni en el arbol
instalado de `~/product` ni entre las deps de produccion verificadas.

### Licencias UNKNOWN / vacias

- En el arbol instalado de `~/product`: **0 UNKNOWN**. Los 4 marcados
  `UNLICENSED` son propios packages privados del workspace (ver seccion 1),
  no licencias indeterminadas de terceros.
- Entre las deps de engine/pieces verificadas con `npm view`: **0 UNKNOWN** —
  todas devolvieron una licencia declarada.

No hay hallazgos que requieran revision manual por licencia indeterminada.

---

## 4. Veredicto

**SCA-lite hecho y publicado: 100% permisivo, sin hallazgos.**

- 11 paquetes instalados en `~/product`: MIT×5, Apache-2.0×1, ISC×1, y 4
  propios `UNLICENSED` (privados, no terceros).
- 13 deps de engine + 3 externals de pieces + jsonata: todas
  MIT / Apache-2.0 / ISC / BSD-3-Clause / 0BSD.
- 0 copyleft, 0 dual/custom, 0 UNKNOWN.

---

## 5. Metodo

- Herramienta: `license-checker` v25.0.1 (instalacion efimera via
  `npx license-checker@latest`).
- Fecha del escaneo: 2026-06-28.
- Comando resumen: `npx license-checker@latest --summary` (sobre `~/product`).
- Comando detalle: `npx license-checker@latest --json` (salida procesada para
  agrupar por licencia).
- Deps no instaladas en `~/product` (bundled desde `~/ap`): verificadas con
  `npm view <pkg> license`.
- Pieces propias (echo/tick/hook): confirmadas sin deps externas via los
  scripts de build (`build-piece-{echo,tick,hook}.mjs`) — solo externals del
  engine.
- Alcance: arbol instalado del workspace + deps de produccion conocidas del
  engine y las pieces demo. No incluye el catalogo community completo mas
  alla de lo ya cubierto en `DEP-AUDIT.md`.

### Advertencia de re-escaneo

El set actual corresponde al producto con las pieces demo (echo/tick/hook/json)
+ catalogo community muestral. **Al elegir conectores adicionales para
comercializar, debe re-correrse este escaneo** (y el `DEP-AUDIT.md`) sobre los
nuevos bundles, porque cada piece community puede arrastrar deps externas
propias. El metodo es reproducible: instalar/verificar y correr
`license-checker` + `npm view`.