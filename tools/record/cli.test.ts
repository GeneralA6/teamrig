import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, recordField, stringField, type JsonRecord } from '../lib/guards.ts';
import { TempRepo, type CliRun } from '../lib/temp-repo.ts';
import { UNRECORDED_REASONS } from './recording.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const VERSION_LINE = '9.8.7 (Claude Code)';
const SCRUBBED_ID = '00000000-0000-4000-8000-000000000001';
/** Tells the stand-in where Claude Code would keep its projects' transcripts. */
const PROJECTS_ENV = 'FAKE_CLAUDE_PROJECTS';
/** Tells the stand-in how to misbehave. */
const MODE_ENV = 'FAKE_CLAUDE_MODE';

/**
 * A stand-in for Claude Code: it prints a version, and on each turn sends the recorder script the hook inputs of that
 * turn and writes the transcripts they name, as Claude Code does. A turn that is not sealed (its environment or its
 * arguments) fails.
 */
const FAKE_CLAUDE = `import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log(${JSON.stringify(VERSION_LINE)});
  process.exit(0);
}
const mode = process.env.${MODE_ENV} ?? '';
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const turn = valueOf('--session-id') !== undefined ? 'tools' : valueOf('-p') === '/compact' ? 'compact' : 'resume';
if (process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS !== '1' || !args.includes('--strict-mcp-config') || valueOf('--setting-sources') !== 'project') {
  console.error('the ' + turn + ' turn is not sealed');
  process.exit(1);
}
if (mode === 'fail' && turn === 'resume') {
  console.log('printed before the failure');
  console.error('  the model is overloaded  ');
  process.exit(3);
}
const session = valueOf('--session-id') ?? valueOf('--resume');
const cwd = process.cwd();
const project = join(process.env.${PROJECTS_ENV}, cwd.replace(/[^A-Za-z0-9]/g, '-'));
const transcript = join(project, (mode === 'two' ? turn + '-' : '') + session + '.jsonl');
const helper = (id) => join(project, session, 'subagents', 'agent-' + id + '.jsonl');
const write = (file, ...entries) => {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, entries.map((entry) => JSON.stringify(entry) + '\\n').join(''));
};
const fire = (event, more = {}) => {
  const named = mode === 'none' ? {} : { transcript_path: transcript };
  const input = JSON.stringify({ session_id: session, ...named, cwd, hook_event_name: event, ...more });
  const result = spawnSync(process.execPath, [join(valueOf('--plugin-dir'), 'record.cjs')], { input });
  if (result.status !== 0) {
    process.exit(70);
  }
};
if (turn === 'tools') {
  fire('SessionStart', { source: 'startup', model: valueOf('--model') });
  write(transcript, { type: 'user', sessionId: session, cwd, message: { role: 'user', content: valueOf('-p') } });
  fire('PreToolUse', { tool_name: 'Read', tool_input: { file_path: join(cwd, 'notes.txt') } });
  write(helper('a1'), { type: 'assistant', sessionId: session, message: { content: [{ type: 'text', text: 'helper' }] } });
  fire('SubagentStop', { agent_id: 'a1', agent_transcript_path: helper('a1') });
  write(transcript, { type: 'attachment', attachment: { type: 'prompt_snapshot', text: 'p'.repeat(500) } });
} else if (turn === 'resume') {
  fire('SessionStart', { source: 'resume' });
  write(transcript, { type: 'assistant', sessionId: session, message: { content: [{ type: 'text', text: 'again' }] } });
} else {
  fire('PreCompact', { trigger: 'manual' });
  fire('SubagentStop', { agent_id: 'a2', agent_type: '', agent_transcript_path: helper('a2') });
}
`;

/** The events the stand-in plugin's manifest wires: three the stand-in fires, and one no headless turn can. */
const MANIFEST = JSON.stringify({ hooks: { SessionStart: [], PreToolUse: [], SubagentStop: [], PreCompact: [], PermissionRequest: [] } });

function jsonOf(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The JSON object `file` holds; anything else fails the test. */
function recordOf(file: string): JsonRecord {
  const value = jsonOf(file);
  assert.ok(isRecord(value), `${file} holds no JSON object`);
  return value;
}

function linesOf(file: string): unknown[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line));
}

describe('record cli', () => {
  let repo: TempRepo;
  let fake: string;
  let projects: string;
  /** The throwaway folders a `--keep` run left, removed after the test. */
  let kept: string[];
  beforeEach(() => {
    repo = new TempRepo('record-cli');
    repo.write('plugins/teamrig/hooks/hooks.json', MANIFEST);
    fake = join(repo.outside, 'fake-claude.mjs');
    repo.write('../outside/fake-claude.mjs', FAKE_CLAUDE);
    projects = join(repo.outside, 'projects');
    kept = [];
  });
  afterEach(() => {
    for (const base of kept) {
      rmSync(base, { recursive: true, force: true });
    }
    repo.remove();
  });

  function record(args: readonly string[] = [], mode = ''): CliRun {
    return repo.run(CLI, ['--claude', process.execPath, '--claude-arg', fake, ...args], { [PROJECTS_ENV]: projects, [MODE_ENV]: mode });
  }

  /** The folders the recorder made in the temp folder and has not removed. */
  function recorderFolders(): string[] {
    const temp = realpathSync.native(tmpdir());
    return readdirSync(temp)
      .filter((name) => name.startsWith('teamrig-record-') && existsSync(join(temp, name, 'out.jsonl')))
      .map((name) => join(temp, name));
  }

  it('records the three sealed turns into a scrubbed fixture, replaces an older one and removes what it made', () => {
    repo.write('fixtures/hooks/Old.json', '[]\n');
    repo.write('fixtures/transcripts/helper-9.jsonl', '{}\n');
    repo.write('fixtures/expected/pins.json', '{}\n');
    const before = recorderFolders();
    const result = record(['--out', 'fixtures', '--model', 'sonnet']);
    assert.deepEqual(result, { status: 0, stdout: `record: 6 hook input(s) of ${VERSION_LINE} written to ${join(repo.dir, 'fixtures')}\n`, stderr: '' });
    const out = join(repo.dir, 'fixtures');
    assert.deepEqual(readdirSync(join(out, 'hooks')).sort(), ['PreCompact.json', 'PreToolUse.json', 'SessionStart.json', 'SubagentStop.json']);
    assert.deepEqual(readdirSync(join(out, 'transcripts')).sort(), ['helper-1.jsonl', 'session.jsonl']);
    assert.ok(repo.has('fixtures/expected/pins.json'));

    const project = `{{temp}}/${basename(dirname(repo.outside))}/outside/projects/{{cwd-slug}}`;
    const common = { session_id: SCRUBBED_ID, transcript_path: `${project}/${SCRUBBED_ID}.jsonl`, cwd: '{{cwd}}' };
    assert.deepEqual(jsonOf(join(out, 'hooks', 'SessionStart.json')), [
      { ...common, hook_event_name: 'SessionStart', source: 'startup', model: 'sonnet' },
      { ...common, hook_event_name: 'SessionStart', source: 'resume' },
    ]);
    assert.deepEqual(jsonOf(join(out, 'hooks', 'PreToolUse.json')), [
      { ...common, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '{{cwd}}/notes.txt' } },
    ]);
    const helperPath = (id: string): string => `${project}/${SCRUBBED_ID}/subagents/agent-${id}.jsonl`;
    assert.deepEqual(jsonOf(join(out, 'hooks', 'SubagentStop.json')), [
      { ...common, hook_event_name: 'SubagentStop', agent_id: 'a1', agent_transcript_path: helperPath('a1') },
      { ...common, hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: '', agent_transcript_path: helperPath('a2') },
    ]);
    const [prompt, snapshot, reply, ...rest] = linesOf(join(out, 'transcripts', 'session.jsonl'));
    assert.deepEqual(rest, []);
    assert.ok(isRecord(prompt));
    assert.deepEqual({ ...prompt, message: undefined }, { type: 'user', sessionId: SCRUBBED_ID, cwd: '{{cwd}}', message: undefined });
    assert.match(stringField(recordField(prompt, 'message') ?? {}, 'content') ?? '', /^Do these steps in order/);
    assert.deepEqual(snapshot, { type: 'attachment', attachment: { type: 'prompt_snapshot', text: '[recorded: 500 characters]' } });
    assert.deepEqual(reply, { type: 'assistant', sessionId: SCRUBBED_ID, message: { content: [{ type: 'text', text: 'again' }] } });
    assert.deepEqual(linesOf(join(out, 'transcripts', 'helper-1.jsonl')), [
      { type: 'assistant', sessionId: SCRUBBED_ID, message: { content: [{ type: 'text', text: 'helper' }] } },
    ]);
    assert.deepEqual(jsonOf(join(out, 'recording.json')), {
      host: 'claude-code',
      version: '9.8.7',
      platform: process.platform,
      model: 'sonnet',
      recorded: { SessionStart: 2, PreToolUse: 1, SubagentStop: 2, PreCompact: 1 },
      order: ['SessionStart', 'PreToolUse', 'SubagentStop', 'SessionStart', 'PreCompact', 'SubagentStop'],
      notRecorded: { PermissionRequest: UNRECORDED_REASONS['PermissionRequest'] },
      transcripts: { 'transcripts/session.jsonl': `${project}/${SCRUBBED_ID}.jsonl`, 'transcripts/helper-1.jsonl': helperPath('a1') },
      cut: { 'transcripts/session.jsonl': 1, 'transcripts/helper-1.jsonl': 0 },
      unwritten: [helperPath('a2')],
    });

    assert.deepEqual(recorderFolders(), before);
    assert.deepEqual(readdirSync(projects), []);
  });

  it('writes to the fixture folder and records with the cheapest model unless told otherwise', () => {
    const result = record();
    assert.equal(result.status, 0, result.stderr);
    const out = join(repo.dir, 'src', 'testing', 'recorded', 'claude-code');
    assert.equal(result.stdout, `record: 6 hook input(s) of ${VERSION_LINE} written to ${out}\n`);
    assert.equal(stringField(recordOf(join(out, 'recording.json')), 'model'), 'haiku');
  });

  it('keeps its throwaway folder and the transcripts when asked to', () => {
    const result = record(['--out', 'fixtures', '--keep']);
    assert.equal(result.status, 0, result.stderr);
    const base = /^record: kept (.+)$/m.exec(result.stdout)?.[1] ?? '';
    assert.ok(recorderFolders().includes(base), result.stdout);
    kept.push(base);
    assert.deepEqual(readdirSync(base).sort(), ['cwd', 'out.jsonl', 'plugin']);
    assert.deepEqual(readdirSync(join(base, 'plugin')).sort(), ['.claude-plugin', 'hooks', 'record.cjs']);
    assert.equal(readFileSync(join(base, 'out.jsonl'), 'utf8').trimEnd().split('\n').length, 6);
    const [project, ...others] = readdirSync(projects);
    assert.deepEqual(others, []);
    assert.equal(readdirSync(join(projects, project ?? '')).filter((name) => name.endsWith('.jsonl')).length, 1);
  });

  it('exits 2 with the turn that failed and what it printed, writes no fixture and removes what it made', () => {
    const before = recorderFolders();
    const result = record(['--out', 'fixtures'], 'fail');
    assert.deepEqual(result, { status: 2, stdout: '', stderr: `record: the resume turn: ${process.execPath} ended with exit 3: the model is overloaded\n` });
    assert.equal(repo.has('fixtures'), false);
    assert.deepEqual(recorderFolders(), before);
  });

  it('exits 2 when the program that runs Claude Code cannot start', () => {
    const missing = join(repo.outside, 'no-claude');
    const result = repo.run(CLI, ['--claude', missing]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /^record: version: .+no-claude did not run: .*ENOENT/);
  });

  it('exits 2 unless the hook inputs name one session transcript', () => {
    for (const [mode, count] of [
      ['none', 0],
      ['two', 3],
    ] as const) {
      const result = record(['--out', 'fixtures'], mode);
      assert.deepEqual(result, { status: 2, stdout: '', stderr: `record: the hook inputs name ${count} session transcripts, not one\n` });
      assert.equal(repo.has('fixtures'), false);
    }
  });

  it('exits 2 on an option it does not know, and when there is no hooks manifest', () => {
    const unknown = record(['--nope']);
    assert.equal(unknown.status, 2, unknown.stdout);
    assert.match(unknown.stderr, /^record: Unknown option '--nope'/);
    const outside = repo.runOutside(CLI);
    assert.equal(outside.status, 2, outside.stdout);
    assert.match(outside.stderr, /^record: ENOENT/);
  });
});
