import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { whoami } from './lib/actions/whoami';

// Minimal own piece built against the pieces-framework, proving the
// credential model: a connection reference -> engine fetch -> context.auth.
export const echoAuth = createPiece({
  displayName: 'Echo Auth',
  description: 'Echoes proof that a connection credential reached the piece.',
  auth: PieceAuth.SecretText({
    displayName: 'API Key',
    required: true,
    description: 'API key proven via its last 4 chars only.',
  }),
  minimumSupportedRelease: '0.30.0',
  logoUrl: 'https://cdn.activepieces.com/pieces/new-core/json-helper.svg',
  authors: ['myorg'],
  actions: [whoami],
  triggers: [],
});
