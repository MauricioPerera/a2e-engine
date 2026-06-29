import { createPiece, PieceAuth } from '@activepieces/pieces-framework';
import { reverseText } from './lib/actions/reverse-text';

// Minimal own piece built against the pieces-framework, proving the
// no-auth action model: a pure text transform over ctx.propsValue.
export const textkit = createPiece({
  displayName: 'TextKit',
  description: 'Small text-transform toolkit (reverse, etc.) with no auth.',
  auth: PieceAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: 'https://cdn.activepieces.com/pieces/new-core/json-helper.svg',
  authors: ['myorg'],
  actions: [reverseText],
  triggers: [],
});
