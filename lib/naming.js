import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { WallkeepError } from './store.js';

const PROMPT = 'Suggest one short, evocative title (2 to 5 words) for this wallpaper based on what it shows. Reply with the title only: no quotes, no punctuation at the end, no explanation.';

/** Returns `suggest(previewPath)` → a title, or throws WallkeepError. Pass `client` in tests. */
export function createNamer({ client = new Anthropic() } = {}) {
  return async function suggest(previewPath) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 2048,
        output_config: { effort: 'low' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: (await readFile(previewPath)).toString('base64') } },
            { type: 'text', text: PROMPT },
          ],
        }],
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) throw new WallkeepError('The AI key was rejected. Check ANTHROPIC_API_KEY.', 503);
      if (error instanceof Anthropic.RateLimitError) throw new WallkeepError('AI naming is busy. Try again in a moment.', 429);
      if (error instanceof Anthropic.APIError) throw new WallkeepError('AI naming failed. Try again.', 502);
      throw new WallkeepError('Could not reach the AI service.', 502);
    }
    if (response.stop_reason === 'refusal') throw new WallkeepError('The AI declined to name this image.', 422);
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
    const title = text.split('\n')[0].replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '').trim().slice(0, 160);
    if (!title) throw new WallkeepError('The AI did not return a name. Try again.', 502);
    return title;
  };
}
