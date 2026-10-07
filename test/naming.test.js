import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNamer } from '../lib/naming.js';

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
