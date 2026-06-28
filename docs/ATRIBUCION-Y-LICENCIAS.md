# Atribución y licencias — Producto A2E

**Propósito:** dejar el producto en regla legal para uso comercial, reutilizando partes MIT de Activepieces.
**Base:** `AUDITORIA-LICENCIAS-ACTIVEPIECES.md` (qué es MIT y qué no).
**Fecha:** 2026-06-27

---

## 1. Qué obliga el MIT (y qué NO te da)

El código reutilizado de Activepieces es **MIT Expat**. El MIT te permite uso comercial (copiar, modificar, vender, sublicenciar) con **una sola obligación**:

> Conservar el aviso de copyright y el texto de la licencia en todas las copias o porciones sustanciales.

El MIT **NO** te transfiere: la **marca** "Activepieces" (nombre/logos), ni cubre las **dependencias de terceros** de cada piece (tienen su propia licencia).

---

## 2. LICENSE del producto (texto a incluir en la raíz de `~/product/LICENSE`)

```
MIT License

Copyright (c) 2026 <TU NOMBRE / TU EMPRESA>

Portions of this software are derived from Activepieces:
Copyright (c) 2020-2024 Activepieces Inc. (MIT Expat)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. NOTICE / procedencia (texto a incluir en `~/product/NOTICE.md`)

```
Este producto incorpora código de Activepieces (https://www.activepieces.com),
licenciado bajo MIT Expat — Copyright (c) 2020-2024 Activepieces Inc.

Componentes derivados de Activepieces (MIT):
- @activepieces/engine y sus dependencias internas (shared, pieces-framework,
  pieces-common, core-utils, core-piece-types, core-formula, core-execution),
  empaquetados en engine-adapter/dist/engine.cjs.
- Las "pieces" (conectores) reutilizadas del catálogo community.

NO se incorpora código bajo la Activepieces Enterprise License
(packages/ee/ ni packages/server/api/src/app/ee/).

"Activepieces" es marca de Activepieces Inc.; este producto no está afiliado
ni respaldado por Activepieces Inc.
```

> **Importante (el bundle):** `engine-adapter/dist/engine.cjs` contiene código MIT de Activepieces compilado. Debe distribuirse acompañado de este aviso de copyright. Si publicas el bundle, incluye el NOTICE.

---

## 4. Declarar licencia en TUS paquetes

Añadir `"license": "MIT"` al `package.json` de cada paquete del producto que hoy no lo declara:
`okf-generator`, `flow-builder`, `backend-mock`, `engine-adapter`, `trigger-runtime`, `product-api`.

(El runtime A2E es código tuyo bajo MIT; las pieces propias `@myorg/*` también.)

---

## 5. Marca / renombrado

- **Renombra el namespace** de las pieces propias y del producto a tu marca (ya usamos `@myorg/*` en las demo — cámbialo por el tuyo real).
- **No uses** el nombre "Activepieces" ni sus logos en tu producto/branding.
- Los nombres internos `@activepieces/*` que aparecen DENTRO del bundle del engine (referencias de pieces, ej. `@activepieces/piece-json`) son identificadores técnicos del código MIT reutilizado, no branding tuyo — no es necesario renombrarlos, pero sí mantener el NOTICE.

---

## 6. Dependencias de terceros (el riesgo real, por-piece)

El MIT de Activepieces **no cubre** las deps npm de cada piece. Antes de comercializar una piece concreta, audita SUS dependencias:

**Método (por cada piece que lleves a producción):**
1. Lee el `package.json` de la piece en `~/ap/packages/pieces/community/<nombre>`.
2. Lista sus `dependencies` (los SDKs del servicio: `@slack/web-api`, `@octokit/*`, etc.).
3. Verifica la licencia de cada una (`npm view <pkg> license`) — acepta permisivas (MIT/Apache-2.0/ISC/BSD); marca cualquier copyleft (GPL/LGPL/AGPL/MPL) o dual/comercial.
4. Revisa marcas/logos del servicio embebidos en la piece (iconos) — no redistribuyas marcas de terceros sin permiso.

**Estado conocido:** las pieces ya probadas (json, flow-helper, y las propias echo/tick) tienen deps mínimas/nulas. Los conectores grandes (slack, github, airtable) traen SDKs — auditar uno a uno al elegirlos.

> Recomendación: corre un escaneo SCA (ScanCode/FOSSA) sobre el conjunto final de pieces que comercialices, para evidencia documental.

---

## 7. Checklist de cierre legal

- [ ] `~/product/LICENSE` con tu copyright + el de Activepieces (sección 2).
- [ ] `~/product/NOTICE.md` con la procedencia (sección 3).
- [ ] `"license": "MIT"` en los 6 package.json del producto (sección 4).
- [ ] Namespace propio en pieces/producto; sin nombre ni logos "Activepieces" (sección 5).
- [ ] Auditoría de deps por-piece de los conectores que comercialices (sección 6).
- [ ] El NOTICE viaja con cualquier distribución del bundle `engine.cjs`.
- [ ] (Opcional, recomendado) escaneo SCA sobre el set final.
