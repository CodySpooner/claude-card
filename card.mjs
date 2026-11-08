#!/usr/bin/env node
// Reads local Claude Code transcripts, writes one self-contained HTML card, opens it.
// Usage: node card.mjs [--name "Your Name"] [--demo] [--no-open]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const top = counts => Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];

function* jsonlFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

// A prompt is something a person typed: not a tool result, subagent turn, or injected wrapper.
function isPrompt(o) {
  if (o.isSidechain || o.isMeta || o.isCompactSummary) return false;
  const c = o.message?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) && !c.some(b => b.type === 'tool_result') ? c.find(b => b.type === 'text')?.text
    : '';
  return !!text && !/^\s*(<(?!command-|pasted)|\[Request interrupted)/.test(text);
}

export function bestStreak(days) {
  const nums = [...days].map(d => Date.parse(`${d}T00:00:00Z`) / 864e5).sort((a, b) => a - b);
  let best = 0, run = 0;
  nums.forEach((n, i) => { run = n - nums[i - 1] === 1 ? run + 1 : 1; best = Math.max(best, run); });
  return best;
}

export async function collect(projectsDir, now = new Date()) {
  // ponytail: one pass over every transcript, per-file cache if this ever outgrows the 10 min Bash limit
  const usage = new Map(), promptIds = new Set(), toolIds = new Set(), sessions = new Set();
  const dayCounts = {}, allDays = new Set(), tools = {}, hours = Array(24).fill(0);
  let first = null;

  for (const file of jsonlFiles(projectsDir)) {
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      // Skip the JSON.parse for line types we never read; transcripts run to gigabytes.
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; } // a transcript being written can end mid-line
      const t = o.timestamp ? new Date(o.timestamp) : null;
      if (!t || isNaN(t)) continue;

      if (o.type === 'assistant' && o.message) {
        if (o.sessionId) sessions.add(o.sessionId);
        allDays.add(dayKey(t));
        if (!first || t < first) first = t;
        for (const b of Array.isArray(o.message.content) ? o.message.content : []) {
          if (b.type !== 'tool_use' || toolIds.has(b.id)) continue;
          toolIds.add(b.id);
          tools[b.name] = (tools[b.name] || 0) + 1;
        }
        // Streaming writes one message across several lines and resumed sessions copy
        // them into new files, so keep one entry per message with its largest count.
        const u = o.message.usage;
        if (u && o.message.model !== '<synthetic>') {
          const id = `${o.message.id}:${o.requestId}`;
          const seen = usage.get(id);
          usage.set(id, {
            model: o.message.model,
            output: Math.max(seen?.output || 0, u.output_tokens || 0),
            rest: Math.max(seen?.rest || 0, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)),
          });
        }
      } else if (o.type === 'user' && isPrompt(o) && !promptIds.has(o.uuid)) {
        promptIds.add(o.uuid);
        if (o.sessionId) sessions.add(o.sessionId);
        allDays.add(dayKey(t));
        if (!first || t < first) first = t;
        hours[t.getHours()]++;
        const k = dayKey(t);
        dayCounts[k] = (dayCounts[k] || 0) + 1;
      }
    }
  }

  let tokens = 0, output = 0;
  const models = {};
  for (const u of usage.values()) {
    tokens += u.output + u.rest;
    output += u.output;
    if (u.model) models[u.model] = (models[u.model] || 0) + u.output;
  }

  const activity = Array.from({ length: 182 }, (_, i) => {
    const d = new Date(now); d.setDate(d.getDate() - 181 + i);
    return dayCounts[dayKey(d)] || 0;
  });
  const builtIn = Object.fromEntries(Object.entries(tools).filter(([n]) => !n.startsWith('mcp__')));

  return {
    tokens, output,
    sessions: sessions.size,
    prompts: promptIds.size,
    toolCalls: toolIds.size,
    activeDays: allDays.size,
    bestStreak: bestStreak(allDays),
    topModel: modelName(top(models)),
    topTool: top(builtIn) || 'None yet',
    peakHour: hours.some(Boolean) ? hours.indexOf(Math.max(...hours)) : null,
    activity,
    firstUsed: first?.toISOString() ?? null,
  };
}

export function modelName(id = '') {
  const m = id.match(/claude-(\d+)(?:-(\d+))?-([a-z]+)/) || id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (!m) return id || 'None yet';
  const [family, major, minor] = /\d/.test(m[1]) ? [m[3], m[1], m[2]] : [m[1], m[2], m[3]];
  return `${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}

// Only the display name goes on the card, never the email or full account record.
function accountInfo() {
  const file = process.env.CLAUDE_CONFIG_DIR ? path.join(CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { displayName: j.oauthAccount?.displayName, since: j.claudeCodeFirstTokenDate || j.firstStartTime };
  } catch { return {}; } // no account file: API-key users, fresh installs
}

function gitName() {
  try { return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

// Flavor text a trading card needs, all derived from the numbers above.
export function persona(s, name, since) {
  const title = [[/Bash|PowerShell/, 'The Operator'], [/Edit|Write/, 'The Author'], [/Read|Grep|Glob/, 'The Scholar'],
    [/Web/, 'The Explorer'], [/Agent|Task/, 'The Commander']].find(([re]) => re.test(s.topTool))?.[1] || 'The Builder';
  const h = s.peakHour;
  const shift = h === null ? 'Fresh Start' : h >= 5 && h < 9 ? 'Early Bird' : h >= 9 && h < 17 ? 'Day Shift' : h >= 17 && h < 21 ? 'Golden Hour' : 'Night Owl';
  const o = s.output;
  const rarity = o >= 1e8 ? 'Legendary' : o >= 2e7 ? 'Epic' : o >= 2e6 ? 'Rare' : o >= 2e5 ? 'Uncommon' : 'Common';
  let hash = 7;
  for (const ch of `${name}${since}`) hash = (hash * 31 + ch.codePointAt(0)) % 9973;
  return { title, shift, rarity, serial: String(hash).padStart(4, '0') };
}

// Escapes "<" so a name like </script> can't break out of the inline script tag.
export function buildHtml(template, stats) {
  return template.replace('/*__STATS__*/null', () => JSON.stringify(stats).replace(/</g, '\\u003c'));
}

const DEMO = {
  tokens: 4_820_000_000, output: 38_400_000, sessions: 212, prompts: 6_430, toolCalls: 41_200,
  activeDays: 96, bestStreak: 17, topModel: 'Opus 5.5', topTool: 'Edit', peakHour: 22,
  activity: Array.from({ length: 182 }, (_, i) => Math.max(0, Math.round(Math.sin(i * 12.9) * 60 + Math.sin(i / 9) * 30))),
  firstUsed: '2026-03-14T12:00:00Z',
};

function open(file) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', file]]
    : process.platform === 'darwin' ? ['open', [file]] : ['xdg-open', [file]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = f => argv.includes(f);
  const nameArg = argv.includes('--name') ? argv[argv.indexOf('--name') + 1]?.trim() : '';
  const account = accountInfo();
  const base = flag('--demo') ? DEMO : await collect(path.join(CONFIG_DIR, 'projects'));
  const name = nameArg || (flag('--demo') ? 'Ada Lovelace' : account.displayName || gitName() || os.userInfo().username);
  const sinceRaw = (!flag('--demo') && account.since) || base.firstUsed || new Date().toISOString();
  const sinceDate = new Date(sinceRaw);
  const since = sinceDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  const stats = { name, since, year: sinceDate.getFullYear(), ...base, ...persona(base, name, since) };
  delete stats.firstUsed;

  const outDir = path.join(CONFIG_DIR, 'claude-card');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, flag('--demo') ? 'demo.html' : 'card.html');
  fs.writeFileSync(out, buildHtml(fs.readFileSync(path.join(HERE, 'card.html'), 'utf8'), stats));
  if (!flag('--no-open')) open(out);
  console.log(`Card ready: ${out}`);
  if (!base.sessions) console.log('No Claude Code history found yet, so this card is blank. Run /card again after a few sessions.');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
