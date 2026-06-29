import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { runAction } from './lib/actions/run';

// Allowlisted-terminal piece: the agent can invoke ONLY binaries on a fixed
// allowlist, via execFile (no shell, args array) — never arbitrary shell.
export const shell = createPiece({
  displayName: 'Shell (allowlisted)',
  description: 'Run an ALLOWLISTED binary with arguments. Deterministic: execFile (no shell), so no injection.',
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.20.0',
  logoUrl: 'https://cdn.activepieces.com/pieces/new-core/json-helper.svg',
  authors: ['myorg'],
  actions: [runAction],
  triggers: [],
});
