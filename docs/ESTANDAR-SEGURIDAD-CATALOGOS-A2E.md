# Estándar de Seguridad de Catálogos — A2E

**Versión:** 0.1 (borrador)
**Ámbito:** define qué debe cubrir un *catálogo de pieces* para que un usuario pueda clonarlo y usarlo en un motor A2E con **consentimiento informado** y **defensa en profundidad**.
**Companion de:** `ESPECIFICACION-A2E.md`.

---

## 1. Filosofía

> El estándar **no previene el mal uso**. Garantiza que el usuario sepa **qué** ejecuta y **de quién** proviene, y que el motor imponga **límites** que acoten el daño aunque una piece sea maliciosa.

Dos garantías, no una promesa de seguridad absoluta:
1. **Transparencia** — el usuario conoce el comportamiento y la procedencia de cada piece *antes* de clonar.
2. **Defensa en profundidad** — el motor aplica capas (sin código arbitrario, egress acotado, secretos por referencia) independientes de la honestidad de la piece.

Las palabras **MUST / SHOULD / MAY** se usan en el sentido de RFC 2119.

---

## 2. Modelo de amenaza

Una piece es **código que se ejecuta in-process** en el motor. Por tanto puede, salvo que se acote:
- hacer peticiones de red arbitrarias (exfiltración de datos, llamada a C2, SSRF),
- leer variables de entorno / sistema de archivos del host,
- intentar acceder a credenciales,
- consumir recursos (DoS local).

El estándar acota estos vectores con **declaración** (lo que la piece dice que hace) + **enforcement** (lo que el motor impide), y con **procedencia** (de quién viene).

NO está en alcance: vulnerabilidades del propio motor, del host, o el mal uso deliberado por parte de un usuario que controla su propio despliegue.

---

## 3. Las 7 dimensiones de un catálogo

| # | Dimensión | Qué cubre |
|---|---|---|
| A | **Procedencia** | Identidad del publicador; versión/commit fijado; hash de contenido; firma (opcional según tier). |
| B | **Transparencia (manifiesto)** | Inventario de pieces + capacidades declaradas por piece (egress, auth, env/fs, código). |
| C | **Cumplimiento legal** | Licencia de cada piece + sus deps; reporte SCA. |
| D | **Higiene de dependencias** | Deps declaradas + licencias + estado de vulnerabilidades; sin binarios nativos/ofuscados sin disclosure. |
| E | **Integridad** | Checksums/firmas de los bundles; build reproducible desde la fuente fijada. |
| F | **Garantías de runtime** | Capas que el motor impone (ver §5). |
| G | **Atestación / tier** | Nivel de confianza visible *antes* de clonar (ver §4). |

---

## 4. Modelo de tiers de confianza (por FUENTE)

El tier modula **cuánta carga de declaración** se exige; las capas universales (§5) aplican a todos.

### T1 — Fuente establecida
Repos con organización pública, comunidad y proceso de revisión reconocidos. **Ejemplo de referencia: Activepieces** (org pública, releases versionados, contribución comunitaria).
- Procedencia: **satisfecha por reputación**.
- MUST: versión/commit **fijado** + hash de integridad (se clona un estado verificable, no una rama móvil).
- NO se exige: manifiesto exhaustivo de capacidades por piece, ni firma propia del catálogo.
- Sub-nota: dentro de T1 conviven pieces *oficiales-mantenidas* y *contribuidas por comunidad* con revisión desigual; MAY anotarse el sub-origen por piece.

### T2 — Comunidad / terceros
Cualquier repo que el usuario aporta y cuya reputación no está establecida.
- MUST: **todo el estándar** — manifiesto de capacidades (§6), build **sandboxeado**, declaración de egress, SCA, integridad.
- El catálogo "se gana" la confianza con evidencia, no con reputación.

### T3 — Propio
Pieces escritas por el propio usuario/organización.
- Confianza por autoría.
- SHOULD: manifiesto, para higiene y para poder promoverlas a un catálogo compartido.

**Requisito transversal:** el tier MUST mostrarse al usuario **antes** de clonar/instalar. El usuario decide sabiendo si trae algo avalado por una comunidad (T1), crudo (T2), o propio (T3).

---

## 5. Capas universales del motor (aplican a T1, T2 y T3)

Independientes de lo que la piece declare; el motor las impone:

1. **Sin code node (MUST).** Solo pieces; cero ejecución de código arbitrario del agente. Determinismo.
2. **Egress de red acotado (MUST para T2; SHOULD para T1/T3).** El motor puede restringir la red (allowlist de dominios; filtro tipo SSRF de Activepieces que rechaza IPs privadas/loopback/metadata). Una piece no puede contactar fuera de lo permitido aunque lo intente.
3. **Secretos solo por referencia (MUST).** Las credenciales se resuelven server-side; la piece recibe el valor solo en el punto de uso, el agente nunca lo ve. Ver `ESPECIFICACION-A2E.md` §6.
4. **Integridad de artefacto (MUST).** Lo que se ejecuta (bundle) MUST ser verificable contra la fuente fijada (build reproducible o checksum firmado).

---

## 6. Esquema del manifiesto (requerido para T2, recomendado para T3)

Un archivo `catalog.manifest.json` (legible por humano y máquina) en la raíz del catálogo:

```json
{
  "catalog": {
    "name": "mi-catalogo",
    "publisher": "org-or-person",
    "source": { "repo": "https://...", "ref": "<commit-or-tag>", "contentHash": "sha256:..." },
    "tier": "T2",
    "signature": "optional"
  },
  "pieces": [
    {
      "name": "@scope/piece-x",
      "version": "1.0.0",
      "artifactHash": "sha256:...",
      "capabilities": {
        "network": { "egress": ["api.example.com"] },
        "auth": "OAUTH2 | SECRET_TEXT | CUSTOM_AUTH | NONE",
        "readsEnv": false,
        "readsFiles": false,
        "executesCode": false
      },
      "license": "MIT",
      "dependencies": [{ "name": "...", "version": "...", "license": "MIT" }],
      "review": { "level": "official | community | none", "by": "...", "at": "..." }
    }
  ],
  "aggregate": { "egressDomains": ["..."], "authsRequired": ["OAUTH2"], "nonPermissiveDeps": [] }
}
```

**Capacidades — origen del dato:**
- Pieces **propias (T3) / T2 que cumplen:** el autor las **declara** (MUST).
- Pieces importadas sin declaración: **inferencia best-effort** (análisis estático de `httpClient`/`fetch`/`process.env`/imports en el código) — MUST marcarse como `"inferred": true` y nunca presentarse como declaración verificada.
- El motor **enforca** el egress aunque el manifiesto sea incompleto: declaración + enforcement, no una sola.

---

## 7. Checklist de conformidad

### MUST (todos los tiers)
- [ ] Tier declarado y mostrado al usuario antes de clonar.
- [ ] Fuente con versión/commit **fijado** + hash de integridad.
- [ ] Sin code node (solo pieces).
- [ ] Secretos solo por referencia.
- [ ] Artefacto verificable contra la fuente (build reproducible o checksum).
- [ ] SCA: ninguna dep copyleft/comercial/UNKNOWN no resuelta (o disclosure explícito).

### MUST adicional para T2 (terceros)
- [ ] `catalog.manifest.json` completo con capacidades por piece.
- [ ] Build **sandboxeado** (contenedor efímero, sin red salvo el clone, límites de recursos).
- [ ] Egress de red **enforced** por allowlist.
- [ ] Capacidades inferidas marcadas como `inferred`.

### SHOULD (recomendado)
- [ ] Firma del catálogo / artefactos.
- [ ] Sub-origen por piece (oficial vs comunidad) en T1.
- [ ] Estado de vulnerabilidades de deps (audit) además de licencias.
- [ ] Resumen agregado (egress total, auths) para decisión de un vistazo.

---

## 8. Huecos honestos (estado actual)

- **Las pieces de Activepieces no declaran capacidades nativamente.** Para T1 se acepta por reputación + enforcement del motor; el manifiesto de capacidades sería **inferido**, no declarado.
- **El enforcement de egress por-piece** requiere que el motor enrute la red de cada piece por un filtro con allowlist; Activepieces aporta la base (`request-filtering-agent`/SSRF guard) pero el allowlist por-piece/por-catálogo es trabajo a implementar.
- **Build sandboxeado para T2** (ejecutar código no confiable al bundlear) requiere un sandbox de build (contenedor sin red) — diseño pendiente.
- La **firma/atestación** y el `contentHash` reproducible son MAY hoy; pasar a MUST exige tooling de verificación.

Estos huecos no invalidan el estándar: definen su **hoja de ruta de enforcement**. El estándar es la meta; las capas se implementan incrementalmente, siempre priorizando que el usuario **sepa** lo que clona.

---

## 9. Relación con el resto del proyecto

- `ESPECIFICACION-A2E.md` — el protocolo (sin código del agente, secretos por referencia): base de las capas 1 y 3.
- `ATRIBUCION-Y-LICENCIAS.md` / `SCA-REPORT.md` — dimensión C (legal) y D (deps).
- *piece source manager* (futuro) — implementaría tiers, discovery, manifiesto y catálogos aislados.
