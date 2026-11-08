// Run with: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect, bestStreak, buildHtml, modelName, persona } from './card.mjs';

const at = (day, hour = 12) => new Date(2026, 0, day, hour).toISOString();
const asst = (id, day, output, content = []) => ({
  type: 'assistant', sessionId: 's1', requestId: 'r' + id, timestamp: at(day),
  message: { id, model: 'claude-opus-5-5', content, usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100 } },
});
const user = (uuid, day, content, extra = {}) => ({ type: 'user', uuid, sessionId: 's1', timestamp: at(day, 21), message: { content }, ...extra });

test('collect counts each message, tool and prompt once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-'));
  const proj = path.join(dir, 'proj-a');
  fs.mkdirSync(proj);
  const tool = { type: 'tool_use', id: 't1', name: 'Bash' };
  const lines = [
    asst('m1', 1, 2, [tool]),   // streaming: early partial count...
    asst('m1', 1, 50),          // ...then the final count for the same message
    user('u1', 1, 'hello'),
    user('u2', 2, [{ type: 'tool_result', content: 'x' }]),
    user('u3', 2, 'injected', { isMeta: true }),
    user('u4', 2, 'subagent', { isSidechain: true }),
    user('u5', 2, '<task-notification>done</task-notification>'),
    user('u6', 3, [{ type: 'text', text: 'second prompt' }]),
    { type: 'mode', timestamp: at(9) },
  ];
  fs.writeFileSync(path.join(proj, 'a.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n{"type":"user","trunc');
  // A resumed session copies history into a new file: must not double count.
  fs.writeFileSync(path.join(proj, 'b.jsonl'), [asst('m1', 1, 50, [tool]), user('u1', 1, 'hello')].map(l => JSON.stringify(l)).join('\n'));

  const s = await collect(dir, new Date(2026, 0, 3, 23));
  assert.equal(s.output, 50);
  assert.equal(s.tokens, 160);
  assert.equal(s.prompts, 2);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.topTool, 'Bash');
  assert.equal(s.topModel, 'Opus 5.5');
  assert.equal(s.sessions, 1);
  assert.equal(s.peakHour, 21);
  assert.equal(s.activity.at(-1), 1); // today
  assert.equal(s.activity.at(-3), 1); // two days ago
});

test('collect handles a machine with no history', async () => {
  const s = await collect(path.join(os.tmpdir(), 'card-does-not-exist'));
  assert.equal(s.tokens, 0);
  assert.equal(s.peakHour, null);
  assert.equal(s.topModel, 'None yet');
  assert.equal(persona(s, 'New', 'Nov 2026').rarity, 'Common');
});

test('bestStreak finds the longest consecutive run', () => {
  assert.equal(bestStreak(new Set(['2026-01-05', '2026-01-01', '2026-01-02', '2026-01-03'])), 3);
  assert.equal(bestStreak(new Set(['2026-02-28', '2026-03-01'])), 2);
  assert.equal(bestStreak(new Set()), 0);
});

test('modelName reads every id format', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-fable-5'), 'Fable 5');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelName('claude-opus-4-20250514'), 'Opus 4');
  assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
});

test('buildHtml cannot be broken out of by a name', () => {
  const html = buildHtml('<script>const S = /*__STATS__*/null;</script>', { name: '</script><img src=x>$&' });
  assert.ok(!html.includes('</script><img'));
  assert.ok(html.includes('$&'));
});
