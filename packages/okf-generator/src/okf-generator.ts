/**
 * Pure OKF emitter: PieceMetadata[] -> OKF file tree (in memory).
 *
 * OKF (Open Knowledge Format) conventions applied:
 *  - directory tree of markdown files
 *  - YAML frontmatter with required `type` + optional title/description/tags
 *  - `index.md` reserved files for progressive discovery
 *  - cross-links as bundle-relative paths beginning with `/`
 *
 * Output layout (root = catalog/):
 *   index.md                         -> lists every piece
 *   <piece>/index.md                 -> piece overview: auth + action/trigger list
 *   <piece>/actions/<action>.md      -> action contract: description + props schema
 *   <piece>/triggers/<trigger>.md    -> trigger contract: strategy + props schema
 *
 * The agent navigates this tree structurally (filesystem + index + links).
 * No embeddings, no RAG.
 */

import type {
  ActionOrTrigger,
  OkfFile,
  PieceMetadataInput,
  PieceProperty,
} from './types.js';

// ---------- small helpers ----------

/** YAML-escape a scalar string for frontmatter (quote if needed). */
function yamlScalar(value: string): string {
  if (value === '') return '""';
  if (/[:#\-?\[\]{}&*!|>'"%@`,\n]/.test(value) || /^\s|\s$/.test(value)) {
    return JSON.stringify(value); // valid YAML double-quoted form
  }
  return value;
}

function yamlList(items: string[]): string {
  if (items.length === 0) return '[]';
  return '[' + items.map((i) => yamlScalar(i)).join(', ') + ']';
}

interface Frontmatter {
  type: string;
  title?: string;
  description?: string;
  resource?: string;
  tags?: string[];
  [key: string]: string | string[] | undefined;
}

function frontmatter(fm: Frontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: ${yamlList(value)}`);
    } else {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** Collapse newlines so a description stays on one frontmatter line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Prefer the AI-facing description when present. */
function agentDescription(item: ActionOrTrigger): string {
  return oneLine(item.aiMetadata?.description || item.description || '');
}

/** Markdown table of an action/trigger's input properties. */
function propsTable(props: Record<string, PieceProperty>): string {
  const entries = Object.entries(props);
  if (entries.length === 0) return '_No input properties._\n';
  const rows = [
    '| Property | Type | Required | Description |',
    '| --- | --- | --- | --- |',
  ];
  for (const [name, p] of entries) {
    const desc = oneLine(p.description || '').replace(/\|/g, '\\|');
    rows.push(
      `| \`${name}\` | ${p.type} | ${p.required ? 'yes' : 'no'} | ${desc} |`,
    );
  }
  return rows.join('\n') + '\n';
}

// ---------- emitters ----------

function emitActionFile(
  piece: PieceMetadataInput,
  action: ActionOrTrigger,
  kind: 'action' | 'trigger',
): OkfFile {
  const fm: Frontmatter = {
    type: kind,
    title: `${piece.displayName} — ${action.displayName}`,
    description: agentDescription(action),
    resource: piece.name,
    tags: [piece.name, kind, ...(action.audience ? [action.audience] : [])],
  };

  const body: string[] = [];
  body.push(`# ${action.displayName}`, '');
  body.push(agentDescription(action) || '_No description._', '');
  body.push('## Reference', '');
  body.push(`- **piece:** \`${piece.name}\``);
  body.push(`- **${kind} name:** \`${action.name}\``);
  body.push(`- **requires auth:** ${action.requireAuth === false ? 'no' : 'yes'}`);
  if (kind === 'trigger' && action.strategy) {
    body.push(`- **strategy:** ${action.strategy}`);
  }
  if (action.aiMetadata?.idempotent !== undefined) {
    body.push(`- **idempotent:** ${action.aiMetadata.idempotent}`);
  }
  body.push('', '## Input properties', '', propsTable(action.props));
  body.push(
    '## Usage in a workflow',
    '',
    `Reference this ${kind} in a \`FlowVersion\` step with:`,
    '',
    '```json',
    JSON.stringify(
      { pieceName: piece.name, [`${kind}Name`]: action.name },
      null,
      2,
    ),
    '```',
    piece.auth && action.requireAuth !== false
      ? `\nProvide credentials via a connection reference: \`{{connections.<name>}}\` (auth type: \`${piece.auth.type}\`).`
      : '',
  );

  return {
    path: `${piece.name}/${kind}s/${action.name}.md`,
    content: frontmatter(fm) + body.join('\n') + '\n',
  };
}

function emitPieceIndex(piece: PieceMetadataInput): OkfFile {
  const actions = Object.values(piece.actions);
  const triggers = Object.values(piece.triggers);

  const fm: Frontmatter = {
    type: 'piece',
    title: piece.displayName,
    description: oneLine(piece.description),
    resource: piece.name,
    tags: [piece.name, ...(piece.categories ?? [])],
  };

  const body: string[] = [];
  body.push(`# ${piece.displayName}`, '');
  body.push(oneLine(piece.description) || '_No description._', '');
  body.push('## Metadata', '');
  body.push(`- **name:** \`${piece.name}\``);
  body.push(`- **version:** ${piece.version}`);
  if (piece.categories?.length) {
    body.push(`- **categories:** ${piece.categories.join(', ')}`);
  }
  body.push(
    `- **auth:** ${piece.auth ? `${piece.auth.type}${piece.auth.required === false ? ' (optional)' : ''}` : 'none'}`,
  );
  body.push('');

  body.push('## Actions', '');
  if (actions.length === 0) {
    body.push('_None._', '');
  } else {
    for (const a of actions) {
      body.push(
        `- [${a.displayName}](/${piece.name}/actions/${a.name}.md) — ${agentDescription(a)}`,
      );
    }
    body.push('');
  }

  body.push('## Triggers', '');
  if (triggers.length === 0) {
    body.push('_None._', '');
  } else {
    for (const t of triggers) {
      body.push(
        `- [${t.displayName}](/${piece.name}/triggers/${t.name}.md) — ${agentDescription(t)}`,
      );
    }
    body.push('');
  }

  return {
    path: `${piece.name}/index.md`,
    content: frontmatter(fm) + body.join('\n') + '\n',
  };
}

function emitRootIndex(pieces: PieceMetadataInput[]): OkfFile {
  const fm: Frontmatter = {
    type: 'index',
    title: 'Piece catalog',
    description:
      'Catalog of available pieces (integrations). Each piece exposes actions and triggers usable in a workflow.',
    tags: ['catalog', 'pieces'],
  };

  const body: string[] = [];
  body.push('# Piece catalog', '');
  body.push(
    `${pieces.length} piece(s) available. Open a piece to see its actions and triggers.`,
    '',
  );
  body.push('| Piece | Actions | Triggers | Auth | Description |');
  body.push('| --- | --- | --- | --- | --- |');
  for (const p of [...pieces].sort((a, b) => a.name.localeCompare(b.name))) {
    const nA = Object.values(p.actions).length;
    const nT = Object.values(p.triggers).length;
    const desc = oneLine(p.description).replace(/\|/g, '\\|');
    body.push(
      `| [${p.displayName}](/${p.name}/index.md) | ${nA} | ${nT} | ${p.auth?.type ?? 'none'} | ${desc} |`,
    );
  }
  body.push('');

  return { path: 'index.md', content: frontmatter(fm) + body.join('\n') + '\n' };
}

/** Generate the full OKF catalog (in memory) from piece metadata. */
export function generateOkfCatalog(pieces: PieceMetadataInput[]): OkfFile[] {
  const files: OkfFile[] = [emitRootIndex(pieces)];
  for (const piece of pieces) {
    files.push(emitPieceIndex(piece));
    for (const action of Object.values(piece.actions)) {
      files.push(emitActionFile(piece, action, 'action'));
    }
    for (const trigger of Object.values(piece.triggers)) {
      files.push(emitActionFile(piece, trigger, 'trigger'));
    }
  }
  return files;
}
