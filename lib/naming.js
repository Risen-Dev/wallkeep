import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      // Billing and request problems (e.g. "credit balance is too low") are actionable, so show the API's own message.
      if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.PermissionDeniedError) throw new WallkeepError(`Claude: ${error.error?.error?.message ?? error.message}`, 502);
      if (error instanceof Anthropic.APIError) throw new WallkeepError('AI naming failed. Try again.', 502);
      throw new WallkeepError('Could not reach the AI service.', 502);
    }
    if (response.stop_reason === 'refusal') throw new WallkeepError('The AI declined to name this image.', 422);
    return cleanTitle(response.content.filter(block => block.type === 'text').map(block => block.text).join(''));
  };
}

function cleanTitle(text) {
  const title = text.trim().split('\n')[0].replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '').trim().slice(0, 160);
  if (!title) throw new WallkeepError('The AI did not return a name. Try again.', 502);
  return title;
}

/** Same contract, via the locally installed and logged-in Codex CLI (uses the ChatGPT plan, no API key). */
export function createCodexNamer({ command = 'codex', model, timeout = 120_000 } = {}) {
  return async function suggest(previewPath) {
    // An empty, read-only working directory: Codex only needs to look at the attached image.
    const directory = await mkdtemp(join(tmpdir(), 'wallkeep-codex-'));
    const output = join(directory, 'title.txt');
    const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only',
      '-C', directory, '-i', previewPath, '-o', output, ...(model ? ['-m', model] : []), PROMPT];
    try {
      await new Promise((resolve, reject) => {
        // stdin must be closed, or `codex exec` waits to append it to the prompt.
        const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        // Own timer instead of spawn's `timeout`, which is never cleared when the command is missing.
        const timer = setTimeout(() => child.kill(), timeout);
        let log = '';
        child.stderr.on('data', chunk => { log = (log + chunk).slice(-8192); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => { clearTimeout(timer); code === 0 ? resolve() : reject(Object.assign(new Error(log), { code, signal })); });
      });
      return cleanTitle(await readFile(output, 'utf8').catch(() => ''));
    } catch (error) {
      if (error instanceof WallkeepError) throw error;
      if (error.code === 'ENOENT') throw new WallkeepError('The codex CLI is not installed on the server.', 503);
      if (error.signal) throw new WallkeepError('Codex took too long to answer. Try again.', 504);
      const reason = error.message.split('\n').reverse().find(line => line.startsWith('ERROR:'))?.slice(6).trim();
      throw new WallkeepError(reason ? `Codex: ${reason}` : 'Codex could not suggest a name. Run `codex login` on the server and try again.', 502);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}

/** Same contract, via 9router's local OpenAI-compatible endpoint; `model` is whatever 9router exposes (a model or combo name). */
export function createRouterNamer({ baseURL = 'http://localhost:20128/v1', apiKey, model, fetcher = fetch } = {}) {
  if (!model) throw new Error('NINEROUTER_MODEL is required for AI_NAMER=9router.');
  return async function suggest(previewPath) {
    const image = `data:image/webp;base64,${(await readFile(previewPath)).toString('base64')}`;
    let response;
    try {
      response = await fetcher(`${baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(120_000),
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: PROMPT }] }] }),
      });
    } catch { throw new WallkeepError('Could not reach 9router. Is it running at NINEROUTER_URL?', 502); }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new WallkeepError(`9router: ${data?.error?.message ?? `HTTP ${response.status}`}`, 502);
    const content = data?.choices?.[0]?.message?.content;
    return cleanTitle(Array.isArray(content) ? content.map(part => part.text ?? '').join('') : content ?? '');
  };
}
