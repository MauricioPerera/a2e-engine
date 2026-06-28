# Auditoria de dependencias de las pieces bundleadas

Fecha: 2026-06-27

## Alcance

Pieces realmente empaquetadas en el producto (engine-adapter):

- community-pieces (catalogo Activepieces community, reutilizadas):
  airtable 0.6.9, flow-helper 0.1.4, github 0.8.3, json 0.1.8, slack 0.17.2
- custom-pieces (json reempaquetado): @activepieces/piece-json 0.1.8
- custom-pieces-echo: @automators/piece-echo-auth 0.1.0 (propia)
- custom-pieces-tick: @automators/piece-tick 0.1.0 (propia)

Se auditan SOLO las `dependencies` (no devDependencies). Las deps internas
`@activepieces/*` con `workspace:*` (pieces-common, pieces-framework,
core-piece-types, core-utils) son codigo Activepieces MIT y se omiten de la
tabla de terceros (cubiertas por NOTICE.md).

## Tabla: piece -> dep externa -> licencia -> permisiva

| Piece | Dep externa (no workspace) | Version | Licencia | Permisiva |
| --- | --- | --- | --- | --- |
| airtable | airtable | 0.11.6 | MIT | si |
| airtable | dayjs | 1.11.9 | MIT | si |
| flow-helper | (ninguna) | - | - | si |
| github | jsonwebtoken | 9.0.1 | MIT | si |
| json | jsonata | ^2.0.0 (2.1.0) | MIT | si |
| slack | @slack/web-api | 7.9.0 | MIT | si |
| slack | slackify-markdown | 4.4.0 | MIT | si |
| slack | zod | 4.3.6 | MIT | si |
| custom json | jsonata | ^2.0.0 (2.1.0) | MIT | si |
| echo (propia) | (ninguna) | - | - | si |
| tick (propia) | (ninguna) | - | - | si |

## Metodo

Licencias verificadas leyendo el package.json de cada paquete en
~/ap/node_modules (instalado) y confirmadas con `npm view <pkg> license`
para airtable@0.11.6 (MIT) y jsonata (MIT).

## Conclusion

TODAS las dependencias externas de las pieces bundleadas son MIT (permisivas).
NO se encontro NINGUNA dependencia copyleft (GPL/LGPL/AGPL/MPL) ni dual/custom
ni de licencia comercial.

- flow-helper y json no aportan deps externas no-permisivas (json usa jsonata MIT).
- Las pieces propias echo y tick no tienen dependencias externas.
