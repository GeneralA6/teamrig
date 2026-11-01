import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { MemoryTranscripts } from '../testing/memory-transcripts.ts';
import { promptLine, replyLine, type FixtureTool } from '../testing/transcript-lines.ts';
import { hookOutputKey } from './scan-hook-output.ts';
import { outermostFolders, projectUse, readTranscriptUse, type UsedIn } from './scan-usage.ts';

const PROJECTS = resolve('/', 'u', '.claude', 'projects');
const AT = '2030-01-08T10:00:00Z';
const SINCE = 1_000;
const RECENT = 2_000;
const UNBOUNDED = Number.MAX_SAFE_INTEGER;
/** Two projects whose folders Claude Code names by one slug, `-work-a-b-c`. */
const SLASH_C = resolve('/', 'work', 'a', 'b-c');
const DASH_B = resolve('/', 'work', 'a-b', 'c');
const DASH_B_WEB = join(DASH_B, 'web');

function skillCall(skill: string): string {
  return replyLine({ id: `m-${skill}`, at: AT, usage: { input: 1, output: 1 }, tools: [{ id: `t-${skill}`, name: 'Skill', skill }] });
}

function callIn(cwd: string | undefined, tools: readonly FixtureTool[]): string {
  return replyLine({ id: `m-${tools[0]?.id ?? 'none'}`, at: AT, ...(cwd === undefined ? {} : { cwd }), usage: { input: 1, output: 1 }, tools });
}

function sorted(usedIn: UsedIn): [string, string[]][] {
  return [...usedIn].map(([name, folders]): [string, string[]] => [name, [...folders].sort()]).sort(([a], [b]) => (a < b ? -1 : 1));
}

describe('readTranscriptUse', () => {
  it("names the skills Skill calls loaded and slash commands ran, in sessions' and subagents' transcripts written since then", async () => {
    const main = [skillCall('alpha-check'), promptLine(AT, '<command-name>/beta-run</command-name>'), promptLine(AT, 'mentions "Skill" in passing'), ''].join('\n');
    const sub = `${skillCall('tr:guide')}\n`;
    const old = `${skillCall('gamma-old')}\n`;
    const source = new MemoryTranscripts();
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a.jsonl'), main, RECENT);
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a', 'subagents', 'agent-1.jsonl'), sub, RECENT);
    source.set(join(PROJECTS, 'other', '0123abcd-0000-4000-8000-00000000000b.jsonl'), old, SINCE - 1);
    const use = await readTranscriptUse(source, PROJECTS, { since: SINCE, maxBytes: UNBOUNDED, chunkBytes: 16 });
    assert.deepEqual(sorted(use.skills), [
      ['alpha-check', []],
      ['beta-run', []],
      ['tr:guide', []],
    ]);
    assert.deepEqual([use.agents.size, use.folders.size], [0, 0]);
    assert.equal(use.transcripts, 2);
    assert.equal(use.bytes, Buffer.byteLength(main) + Buffer.byteLength(sub));
    assert.deepEqual([use.unread, use.since], [0, SINCE]);
  });

  it('names the agent types Agent calls ran and the folder each session started in, by its first cwd, never the slug (T1232)', async () => {
    const slashC = [
      callIn(undefined, [{ id: 's1', name: 'Skill', skill: 'alpha-check' }]),
      callIn(SLASH_C, [{ id: 'a1', name: 'Agent', agent: 'code-reader' }]),
      callIn(DASH_B, [{ id: 'b1', name: 'Bash', command: 'ls' }]),
      '',
    ].join('\n');
    const dashB = [callIn(DASH_B_WEB, [{ id: 's2', name: 'Skill', skill: 'alpha-check' }, { id: 'a2', name: 'Agent' }]), promptLine(AT, '<command-name>/beta-run</command-name>'), ''].join('\n');
    const nowhere = `${skillCall('gamma-x')}\n`;
    const source = new MemoryTranscripts();
    source.set(join(PROJECTS, '-work-a-b-c', '0123abcd-0000-4000-8000-00000000000a.jsonl'), slashC, RECENT);
    source.set(join(PROJECTS, '-work-a-b-c', '0123abcd-0000-4000-8000-00000000000b.jsonl'), dashB, RECENT);
    source.set(join(PROJECTS, 'other', '0123abcd-0000-4000-8000-00000000000c.jsonl'), nowhere, RECENT);
    const use = await readTranscriptUse(source, PROJECTS, { since: SINCE, maxBytes: UNBOUNDED, chunkBytes: 64 });
    assert.deepEqual(sorted(use.skills), [
      ['alpha-check', [SLASH_C, DASH_B_WEB].sort()],
      ['beta-run', [DASH_B_WEB]],
      ['gamma-x', []],
    ]);
    assert.deepEqual(sorted(use.agents), [
      ['code-reader', [SLASH_C]],
      ['general-purpose', [DASH_B_WEB]],
    ]);
    assert.deepEqual(
      new Map(use.folders),
      new Map([
        [SLASH_C, 1],
        [DASH_B_WEB, 1],
      ]),
    );
    assert.equal(use.transcripts, 3);
  });

  it('reads the newest transcripts first and starts none past the bound, the window starting at the oldest one read', async () => {
    const source = new MemoryTranscripts();
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a.jsonl'), `${skillCall('skill-mid')}\n`, 2_500);
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000b.jsonl'), `${skillCall('skill-old')}\n`, RECENT);
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000c.jsonl'), `${skillCall('skill-new')}\n`, 3_000);
    const one = Buffer.byteLength(`${skillCall('skill-new')}\n`);
    const use = await readTranscriptUse(source, PROJECTS, { since: SINCE, maxBytes: one + 1 });
    assert.deepEqual([...use.skills.keys()].sort(), ['skill-mid', 'skill-new']);
    assert.deepEqual([use.transcripts, use.bytes, use.unread, use.since], [2, 2 * one, 1, 2_500]);
  });

  it("sums what each context hook printed across the transcripts read, by event and command, other events' runs left out (T1233)", async () => {
    const run = (event: string, command: string, stdout: string): string => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', hookEvent: event, content: stdout, stdout, command } });
    const context = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
    const first = [run('SessionStart', 'node start.js', context('r'.repeat(300))), run('SessionStart', 'node title.js', '{"terminalSequence":"t"}'), run('PostToolUse', 'node after.js', 'printed'), ''].join('\n');
    const second = [run('SessionStart', 'node start.js', context('r'.repeat(100))), run('UserPromptSubmit', 'node inbox.js', 'news\n'), ''].join('\n');
    const source = new MemoryTranscripts();
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a.jsonl'), first, RECENT);
    source.set(join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000b.jsonl'), second, RECENT);
    const use = await readTranscriptUse(source, PROJECTS, { since: SINCE, maxBytes: UNBOUNDED, chunkBytes: 64 });
    assert.deepEqual(
      use.hooks,
      new Map([
        [hookOutputKey('SessionStart', 'node start.js'), { runs: 2, printed: 2, chars: 400 }],
        [hookOutputKey('SessionStart', 'node title.js'), { runs: 1, printed: 0, chars: 0 }],
        [hookOutputKey('UserPromptSubmit', 'node inbox.js'), { runs: 1, printed: 1, chars: 4 }],
      ]),
    );
  });

  it('reads nothing when no transcript was written since then', async () => {
    const source = new MemoryTranscripts({ [join(PROJECTS, 'app', '0123abcd-0000-4000-8000-00000000000a.jsonl')]: `${skillCall('alpha-check')}\n` }, SINCE - 1);
    assert.deepEqual(await readTranscriptUse(source, PROJECTS, { since: SINCE, maxBytes: UNBOUNDED }), {
      skills: new Map(),
      agents: new Map(),
      folders: new Map(),
      hooks: new Map(),
      transcripts: 0,
      bytes: 0,
      unread: 0,
      since: SINCE,
    });
    assert.equal(source.bytesRead, 0);
  });
});

describe('projectUse', () => {
  const use = {
    skills: new Map([
      ['alpha-check', new Set([SLASH_C, DASH_B_WEB])],
      ['beta-run', new Set([DASH_B_WEB])],
      ['gamma-x', new Set<string>()],
    ]),
    agents: new Map([['code-reader', new Set([SLASH_C])]]),
    folders: new Map([
      [SLASH_C, 2],
      [DASH_B_WEB, 3],
    ]),
    hooks: new Map(),
    transcripts: 6,
    bytes: 0,
    unread: 0,
    since: SINCE,
  };

  it('keeps what the sessions started in the project or below it used (T1232)', () => {
    assert.deepEqual(projectUse(use, DASH_B), { transcripts: 3, skills: new Set(['alpha-check', 'beta-run']), agents: new Set() });
    assert.deepEqual(projectUse(use, SLASH_C), { transcripts: 2, skills: new Set(['alpha-check']), agents: new Set(['code-reader']) });
    assert.deepEqual(projectUse(use, resolve('/', 'work')), { transcripts: 5, skills: new Set(['alpha-check', 'beta-run']), agents: new Set(['code-reader']) });
  });

  it('keeps nothing for a folder inside a start folder, nor for a sibling whose name only begins the same', () => {
    assert.deepEqual(projectUse(use, join(DASH_B_WEB, 'src')), { transcripts: 0, skills: new Set(), agents: new Set() });
    assert.deepEqual(projectUse(use, resolve('/', 'work', 'a')), { transcripts: 2, skills: new Set(['alpha-check']), agents: new Set(['code-reader']) });
  });
});

describe('outermostFolders', () => {
  it('drops each folder another one holds, keeps siblings whose names only begin the same, and sorts them', () => {
    assert.deepEqual(outermostFolders([DASH_B_WEB, SLASH_C, DASH_B, join(DASH_B, 'web-2')]), [DASH_B, SLASH_C].sort());
    assert.deepEqual(outermostFolders([DASH_B_WEB, join(DASH_B, 'web-2')]), [DASH_B_WEB, join(DASH_B, 'web-2')]);
  });

  it('keeps one spelling of a folder named twice on Windows, where case does not matter', () => {
    assert.deepEqual(outermostFolders(['C:\\Work\\App', 'c:\\work\\app', 'C:\\Work\\App\\web'], 'win32'), ['c:\\work\\app']);
    assert.deepEqual(outermostFolders(['/work/App', '/work/app'], 'linux'), ['/work/App', '/work/app']);
  });
});
