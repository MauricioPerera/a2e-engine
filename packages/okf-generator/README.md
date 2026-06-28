# okf-generator

Genera un catálogo **OKF** (Open Knowledge Format) a partir de la metadata de pieces
de Activepieces, para que un agente descubra pieces **sin vectores ni RAG** —
navegando un árbol de markdown con frontmatter e `index.md`.

Parte del diseño en `../ANEXO-ARQUITECTURA-MOTOR-API.md` (Componente 1).

## Estado

- ✅ **Emisor OKF puro** (`src/okf-generator.ts`): `PieceMetadata[] → árbol de archivos`. Sin dependencias de Activepieces; corre standalone.
- ✅ **CLI** (`src/cli.ts`): escribe el catálogo a disco.
- ✅ **Fixture** (`src/fixtures/sample-pieces.ts`): metadata real de ejemplo (Slack, HTTP).
- ⏳ **Wiring de pieces reales**: pendiente (requiere build del monorepo AP). Ver abajo.

## Uso

```bash
npm install
npm run demo            # escribe ./out/catalog desde el fixture
# o:
tsx src/cli.ts <outDir>
```

## Layout de salida (OKF)

```
catalog/
  index.md                       # lista todas las pieces (descubrimiento raíz)
  <piece>/index.md               # overview: auth + lista de actions/triggers
  <piece>/actions/<action>.md    # contrato de la action: descripción + tabla de props
  <piece>/triggers/<trigger>.md  # contrato del trigger: estrategia + tabla de props
```

Convenciones OKF aplicadas: frontmatter YAML con `type` obligatorio, `index.md`
reservado para listados, cross-links bundle-relativos que empiezan con `/`.

## Decisiones de diseño aplicadas

- **Solo lo visible para el agente:** se excluyen actions/triggers con `audience: 'human'`.
- **Descripción AI-first:** se prefiere `aiMetadata.description` sobre la genérica.
- **Credenciales por referencia:** los docs de actions con auth indican usar
  `{{connections.<name>}}` (nunca el secreto), acorde al modelo vault del anexo.
- **Salida estática en disco:** versionable con git, navegable con `cat`. (No on-the-fly.)

## Wiring de pieces reales (paso de integración futuro)

El emisor consume objetos con la forma de `PieceMetadataInput` (`src/types.ts`),
que es estructuralmente compatible con el resultado de `piece.metadata()` en
`@activepieces/pieces-framework`.

Para generar desde pieces reales:

1. Construye/instala las piece(s) que vayas a usar (las tuyas y/o community).
2. Importa cada piece (export default = objeto `Piece`).
3. Llama `piece.metadata()` y pásalo a `generateOkfCatalog([...])`.

```ts
import { generateOkfCatalog } from './okf-generator.js';
import slack from '@tuempresa/piece-slack';        // export default = Piece
const catalog = generateOkfCatalog([slack.metadata() as any]);
```

> Nota: `piece.metadata()` incluye más campos (logoUrl, i18n, etc.) que
> `PieceMetadataInput` ignora sin problema. El mapeo de `auth` puede requerir
> derivar `{ type }` desde `PieceAuthProperty` según el tipo de conexión.
