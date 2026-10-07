import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexNamer, createNamer, createRouterNamer } from '../lib/naming.js';

test('AI namer sends the preview and cleans the suggested title', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wallkeep-naming-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preview = join(directory, 'preview.webp');
  writeFileSync(preview, 'webp-bytes');
  let request, reply = { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '"Misty Pine Morning."\nextra' }] };
  const client = { beta: { messages: { create: async params => { request = params; return reply; } } } };
  const suggest = createNamer({ client });
  assert.equal(await suggest(preview), 'Misty Pine Morning');
  assert.equal(request.model, 'claude-opus-5-5');
  assert.equal(request.messages[0].content[0].source.data, Buffer.from('webp-bytes').toString('base64'));
  reply = { stop_reason: 'refusal', content: [] };
  await assert.rejects(suggest(preview), /declined/);
  reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '  ' }] };
  await assert.rejects(suggest(preview), /did not return/);
});

test('Codex namer runs the CLI with the preview and reports its errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wallkeep-codex-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preview = join(directory, 'preview.webp');
  writeFileSync(preview, 'webp-bytes');
  // A stand-in `codex`: checks the image flag and writes the -o file, or fails like a usage limit.
  const fake = join(directory, 'codex');
  writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (process.env.FAKE_FAIL) { console.error('ERROR: You have hit your usage limit.'); process.exit(1); }
if (args[args.indexOf('-i') + 1] !== ${JSON.stringify(preview)}) process.exit(2);
require('fs').writeFileSync(args[args.indexOf('-o') + 1], 'Quiet Harbor Dusk.\\n');
`);
  chmodSync(fake, 0o755);
  assert.equal(await createCodexNamer({ command: fake })(preview), 'Quiet Harbor Dusk');
  process.env.FAKE_FAIL = '1';
  t.after(() => { delete process.env.FAKE_FAIL; });
  await assert.rejects(createCodexNamer({ command: fake })(preview), /Codex: You have hit your usage limit/);
  await assert.rejects(createCodexNamer({ command: join(directory, 'missing') })(preview), /not installed/);
});

test('9router namer sends an OpenAI-style image request and reports router errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'wallkeep-router-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preview = join(directory, 'preview.webp');
  writeFileSync(preview, 'webp-bytes');
  let request, reply = Response.json({ choices: [{ message: { content: 'Neon Rain Alley.' } }] });
  const fetcher = async (url, options) => { request = { url, ...options, body: JSON.parse(options.body) }; return reply; };
  const suggest = createRouterNamer({ baseURL: 'http://router.test/v1/', apiKey: 'k', model: 'combo-vision', fetcher });
  assert.equal(await suggest(preview), 'Neon Rain Alley');
  assert.equal(request.url, 'http://router.test/v1/chat/completions');
  assert.equal(request.headers.Authorization, 'Bearer k');
  assert.equal(request.body.model, 'combo-vision');
  assert.equal(request.body.messages[0].content[0].image_url.url, `data:image/webp;base64,${Buffer.from('webp-bytes').toString('base64')}`);
  reply = Response.json({ error: { message: 'No provider available' } }, { status: 503 });
  await assert.rejects(suggest(preview), /9router: No provider available/);
  assert.throws(() => createRouterNamer({}), /NINEROUTER_MODEL/);
});
