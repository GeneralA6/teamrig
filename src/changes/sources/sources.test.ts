import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeQuery, ChangeRead, ResolvedPoint } from '../source.ts';
import { changeDepsOf, commitOf, FakeChangeGit, registerTaskOf, taskReaderOf } from '../../testing/fake-change-git.ts';
import { MemoryFiles } from '../../testing/memory-files.ts';
import { assertWithin } from '../../testing/time-bound.ts';
import { GIT_SOURCE } from './git.ts';
import { NOTES_SOURCE, readNote } from './notes.ts';
import { REGISTER_SOURCE } from './register.ts';

const SINCE: ResolvedPoint = { version: '0.1.0', at: '2026-11-14T12:00:00.000Z', ref: 'r0100000000' };
const QUERY: ChangeQuery = { since: SINCE, until: undefined, file: undefined, area: undefined };

const HISTORY = [
  commitOf('r0200000000', '2026-11-16T12:00:00.000Z', 'plugin: version 0.2.0, open on Windows (T12)', ['plugins/teamrig/.claude-plugin/plugin.json']),
  commitOf('d0000000000', '2026-11-16T11:30:00.000Z', 'build: rebuild the plugin dist', ['plugins/teamrig/dist/teamrig.js']),
  commitOf('f2000000000', '2026-11-16T11:00:00.000Z', 'fix(open): fall back to a console tab (T12)', ['src/open/tab.ts']),
  commitOf('f1000000000', '2026-11-15T11:00:00.000Z', 'open: name the terminal it opens (T12)', ['src/open/name.ts']),
  commitOf('c1000000000', '2026-11-15T10:00:00.000Z', 'feat(cli)!: --team is required (#40)', ['src/cli/run.ts']),
  commitOf('r0100000000', '2026-11-14T12:00:00.000Z', 'plugin: version 0.1.0, first', []),
];

function entriesOf(read: ChangeRead): Extract<ChangeRead, { kind: 'read' }> {
  assert.equal(read.kind, 'read');
  return read;
}

describe('the git source', () => {
  it('applies to a project that is a git repository', async () => {
    assert.equal(await GIT_SOURCE.detect(changeDepsOf({ files: new MemoryFiles({ '/work/app/.git/HEAD': 'ref: x' }) })), true);
    assert.equal(await GIT_SOURCE.detect(changeDepsOf()), false);
  });

  it('reads each commit past the release as an entry, but its release, build and test commits', async () => {
    const read = entriesOf(await GIT_SOURCE.read(changeDepsOf({ git: new FakeChangeGit(HISTORY) }), QUERY));
    assert.deepEqual(
      read.entries.map((entry) => [entry.area, entry.kind, entry.text, entry.refs]),
      [
        ['open', 'fix', 'fall back to a console tab', ['f20000000', 'T12']],
        ['open', 'other', 'name the terminal it opens', ['f10000000', 'T12']],
        ['cli', 'behaviour', '--team is required (#40)', ['c10000000', '#40']],
      ],
    );
  });

  it('asks git for the asked file only', async () => {
    const git = new FakeChangeGit(HISTORY);
    await GIT_SOURCE.read(changeDepsOf({ git }), { ...QUERY, file: 'src/open/' });
    assert.deepEqual(git.logs[0]?.paths, ['src/open/']);
  });

  it('reports git refusing as a failed read', async () => {
    const git = new FakeChangeGit(HISTORY);
    git.failure = 'fatal: not a git repository';
    assert.deepEqual(await GIT_SOURCE.read(changeDepsOf({ git }), QUERY), { kind: 'failed', error: 'fatal: not a git repository' });
  });
});

describe('the register source', () => {
  const register = taskReaderOf([registerTaskOf('T12', 'teamrig open works on Windows with no Windows Terminal', { type: 'bug', ref: 'gh:acme/app#7' })]);

  it('applies only where the project has a team', async () => {
    assert.equal(await REGISTER_SOURCE.detect(changeDepsOf({ register })), true);
    assert.equal(await REGISTER_SOURCE.detect(changeDepsOf()), false);
  });

  it('reads one entry per task its commits name, its title as the text and its first commit setting the area', async () => {
    const read = entriesOf(await REGISTER_SOURCE.read(changeDepsOf({ git: new FakeChangeGit(HISTORY), register }), QUERY));
    assert.equal(read.entries.length, 1);
    const [entry] = read.entries;
    assert.equal(entry?.text, 'teamrig open works on Windows with no Windows Terminal');
    assert.equal(entry?.kind, 'fix');
    assert.equal(entry?.area, 'open');
    assert.equal(entry?.at, '2026-11-16T12:00:00.000Z');
    assert.deepEqual(entry?.files, ['src/open/tab.ts', 'src/open/name.ts']);
    assert.deepEqual(entry?.refs, ['T12', '#7', 'r02000000', 'f20000000', 'f10000000']);
  });

  it('leaves a task the register does not hold, and a commit naming none, to the git source', async () => {
    const read = entriesOf(await REGISTER_SOURCE.read(changeDepsOf({ git: new FakeChangeGit(HISTORY), register: taskReaderOf([]) }), QUERY));
    assert.deepEqual(read.entries, []);
  });

  it('calls a task a feature when one of its commits is one, and a behaviour change wins over both', async () => {
    const tasks = taskReaderOf([registerTaskOf('T1', 'one'), registerTaskOf('T2', 'two', { type: 'bug' })]);
    const git = new FakeChangeGit([
      commitOf('a1', '2026-11-16T10:00:00.000Z', 'feat(x): one (T1)'),
      commitOf('a2', '2026-11-16T09:00:00.000Z', 'fix(x)!: two (T2)'),
    ]);
    const read = entriesOf(await REGISTER_SOURCE.read(changeDepsOf({ git, register: tasks }), { ...QUERY, since: { version: undefined, at: undefined, ref: undefined } }));
    assert.deepEqual(
      read.entries.map((entry) => [entry.text, entry.kind]),
      [
        ['one', 'feature'],
        ['two', 'behaviour'],
      ],
    );
  });
});

describe('the notes source', () => {
  const note = (head: string, text = 'Run teamrig setup again.') => `---\n${head}\n---\n${text}\n`;

  it('reads a note with its front matter, defaulting the kind and audience', () => {
    assert.deepEqual(readNote('changes/a.md', note('area: Open\nfiles: src/open/, docs/commands.md\nrefs: T12, #7')), {
      kind: 'entry',
      entry: {
        source: 'notes',
        version: undefined,
        at: undefined,
        area: 'open',
        kind: 'other',
        audience: 'lead',
        text: 'Run teamrig setup again.',
        action: undefined,
        files: ['src/open/', 'docs/commands.md'],
        refs: ['T12', '#7'],
      },
    });
  });

  it('reads an action with its step, for everyone', () => {
    const read = readNote('changes/a.md', note('area: setup\nkind: action\naudience: all\naction: teamrig setup --repair'));
    assert.equal(read.kind, 'entry');
    assert.equal(read.kind === 'entry' ? read.entry.action : undefined, 'teamrig setup --repair');
  });

  it('reads a front matter line of any length in linear time', async () => {
    const read = await assertWithin(1000, () => readNote('changes/a.md', note(`area:${' '.repeat(120_000)}open web`)));
    assert.equal(read.kind === 'entry' ? read.entry.area : read.warning, 'open web');
  });

  it('names what is wrong with a bad note, by file and line', () => {
    const warning = (text: string) => {
      const read = readNote('changes/a.md', text);
      return read.kind === 'bad' ? read.warning : undefined;
    };
    assert.match(warning('no fences') ?? '', /^changes\/a\.md:1 has no front matter/);
    assert.equal(warning(note('area: x\nnot a field')), 'changes/a.md:3 is no "key: value" line');
    assert.match(warning(note('kind: news')) ?? '', /kind "news" is none of/);
    assert.match(warning(note('audience: owner')) ?? '', /audience "owner" is none of/);
    assert.match(warning(note('kind: action')) ?? '', /needs an action line/);
    assert.match(warning(note('area: x', '  ')) ?? '', /no text below/);
  });

  it('reads every note in changes/ but its README, and names the bad ones as warnings', async () => {
    const files = new MemoryFiles({
      '/work/app/changes/b-open.md': note('area: open\nkind: fix'),
      '/work/app/changes/a-bad.md': 'no fences',
      '/work/app/changes/README.md': 'How to write a note.',
      '/work/app/changes/c.txt': 'not a note',
    });
    const deps = changeDepsOf({ files });
    assert.equal(await NOTES_SOURCE.detect(deps), true);
    const read = entriesOf(await NOTES_SOURCE.read(deps, QUERY));
    assert.deepEqual(
      read.entries.map((entry) => entry.area),
      ['open'],
    );
    assert.equal(read.warnings.length, 1);
    assert.match(read.warnings[0] ?? '', /^changes\/a-bad\.md:1/);
  });

  it('does not apply to a project with no notes folder', async () => {
    assert.equal(await NOTES_SOURCE.detect(changeDepsOf()), false);
  });
});
