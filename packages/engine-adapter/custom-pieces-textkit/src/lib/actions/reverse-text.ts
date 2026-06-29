import { createAction, Property } from '@activepieces/pieces-framework';

// Reverses the characters of the input text. No auth, no network: a pure
// transform over ctx.propsValue.text.
export const reverseText = createAction({
  name: 'reverse_text',
  displayName: 'Reverse Text',
  description: 'Reverse the characters of the input text.',
  requireAuth: false,
  props: {
    text: Property.LongText({
      displayName: 'Text',
      description: 'The text whose characters will be reversed.',
      required: true,
    }),
  },
  async run(context) {
    const text: string = context.propsValue.text;
    return text.split('').reverse().join('');
  },
});
