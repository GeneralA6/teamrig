import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChangeEntry, ChangeSource, Release } from './source.ts';
import { compareVersions, parsePoint, readChanges, type ChangesAsk } from './read.ts';
import { changeDepsOf, commitOf, FakeChangeGit, registerTaskOf, taskReaderOf } from '../testing/fake-change-git.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { CHANGE_SOURCES } from './registry.ts';

const RELEASES: readonly Release[] = [
  { version: '0.3.0', at: '2026-11-16T12:00:00.000Z', sha: 'r0300000000' },
  { version: '0.2.0', at: '2026-11-15T12:00:00.000Z', sha: 'r0200000000' },
  { version: '0.1.0', at: '2026-11-14T12:00:00.000Z', sha: 'r0100000000' },
];

const HISTORY = [
  commitOf('n1000000000', '2026-11-16T13:00:00.000Z', 'feat(cli): a flag not released yet'),
  commitOf('r0300000000', '2026-11-16T12:00:00.000Z', 'plugin: version 0.3.0, x'),
  commitOf('b3000000000', '2026-11-16T11:00:00.000Z', 'fix(open): a console tab (T12)', ['src/open/tab.ts']),
  commitOf('a3000000000', '2026-11-16T10:00:00.000Z', 'docs: the open page', ['docs/open.md']),
  commitOf('r0200000000', '2026-11-15T12:00:00.000Z', 'plugin: version 0.2.0, x'),
  commitOf('a2000000000', '2026-11-15T10:00:00.000Z', 'feat(ship)!: ship needs --approved', ['tools/ship/ship.ts']),
  commitOf('r0100000000', '2026-11-14T12:00:00.000Z', 'plugin: version 0.1.0, x'),
  commitOf('a1000000000', '2026-11-14T10:00:00.000Z', 'feat: the first one'),
];

const ASK: ChangesAsk = { since: { kind: 'version', version: '0.1.0' }, until: undefined, file: undefined, area: undefined, sources: ['git'] };

function deps(overrides: Parameters<typeof changeDepsOf>[0] = {}) {
  return changeDepsOf({ git: new FakeChangeGit(HISTORY, RELEASES), ...overrides });
}

async function reportOf(ask: Partial<ChangesAsk>, depsOf = deps()) {
  const report = await readChanges(depsOf, CHANGE_SOURCES, { ...ASK, ...ask });
  assert.equal(report.kind, 'report');
  return report;
}

const shown = (entries: readonly ChangeEntry[]) => entries.map((entry) => `${entry.version ?? 'unreleased'} ${entry.kind} ${entry.area}: ${entry.text}`);

describe('compareVersions and parsePoint', () => {
  it('orders versions by number, a pre-release before its release', () => {
    assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
    assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('reads a version, else a time by the reader it is given, as an ISO time', () => {
    const instantOf = (text: string) => (text === 'yesterday' ? new Date('2026-11-15T22:00:00Z') : undefined);
    assert.deepEqual(parsePoint('v0.447.0', instantOf), { kind: 'version', version: '0.447.0' });
    assert.deepEqual(parsePoint(' yesterday ', instantOf), { kind: 'date', at: '2026-11-15T22:00:00.000Z' });
    assert.equal(parsePoint('last week', instantOf), undefined);
    assert.equal(parsePoint('0.447', instantOf), undefined);
  });
});

describe('readChanges', () => {
  it('names each entry past the version by the release it shipped in, newest first, the unreleased ones on top', async () => {
    const report = await reportOf({});
    assert.deepEqual(shown(report.entries), [
      'unreleased feature cli: a flag not released yet',
      '0.3.0 fix open: a console tab',
      '0.3.0 other general: the open page',
      '0.2.0 behaviour ship: ship needs --approved',
    ]);
    assert.deepEqual(report.read, ['git']);
    assert.equal(report.since.ref, 'r0100000000');
  });

  it('ends at --until, by its release', async () => {
    const report = await reportOf({ until: { kind: 'version', version: '0.2.0' } });
    assert.deepEqual(shown(report.entries), ['0.2.0 behaviour ship: ship needs --approved']);
  });

  it('reads a range by time, and still names each entry by its release', async () => {
    const report = await reportOf({ since: { kind: 'date', at: '2026-11-16T00:00:00.000Z' } });
    assert.deepEqual(shown(report.entries), ['unreleased feature cli: a flag not released yet', '0.3.0 fix open: a console tab', '0.3.0 other general: the open page']);
  });

  it('narrows to a file or folder and to an area', async () => {
    assert.deepEqual(shown((await reportOf({ file: 'src/open' })).entries), ['0.3.0 fix open: a console tab']);
    assert.deepEqual(shown((await reportOf({ area: 'Ship' })).entries), ['0.2.0 behaviour ship: ship needs --approved']);
  });

  it('refuses a version the release index does not hold, naming the ones it does', async () => {
    assert.deepEqual(await readChanges(deps(), CHANGE_SOURCES, { ...ASK, since: { kind: 'version', version: '0.9.0' } }), {
      kind: 'unknown-version',
      version: '0.9.0',
      known: ['0.3.0', '0.2.0', '0.1.0'],
    });
  });

  it('refuses a source it does not have', async () => {
    assert.deepEqual(await readChanges(deps(), CHANGE_SOURCES, { ...ASK, sources: ['git', 'jira'] }), { kind: 'unknown-source', source: 'jira', known: ['notes', 'register', 'git'] });
  });

  it('reads every source that applies under auto, and keeps one change two of them name once, the earlier one', async () => {
    const register = taskReaderOf([registerTaskOf('T12', 'teamrig open works with no Windows Terminal', { type: 'bug' })]);
    const files = new MemoryFiles({ '/work/app/.git/HEAD': 'ref: x' });
    const report = await reportOf({ sources: 'auto' }, deps({ files, register }));
    assert.deepEqual(report.read, ['register', 'git']);
    assert.deepEqual(shown(report.entries), [
      'unreleased feature cli: a flag not released yet',
      '0.3.0 fix open: teamrig open works with no Windows Terminal',
      '0.3.0 other general: the open page',
      '0.2.0 behaviour ship: ship needs --approved',
    ]);
  });

  it('gives a note not released yet no version, and passes its warnings on by source', async () => {
    const files = new MemoryFiles({ '/work/app/changes/a.md': '---\narea: setup\nkind: action\naction: teamrig setup\n---\nRun setup again.\n', '/work/app/changes/b.md': 'bad' });
    const report = await reportOf({ sources: ['notes'] }, deps({ files }));
    assert.deepEqual(shown(report.entries), ['unreleased action setup: Run setup again.']);
    assert.deepEqual(report.warnings, ['notes: changes/b.md:1 has no front matter: start it with --- lines naming its area and kind']);
  });

  it('reports a source that failed beside the others, and reads no releases when git cannot', async () => {
    const failing: ChangeSource = {
      id: 'broken',
      capabilities: { byVersion: false, byDate: false, byFile: false, byArea: false, classified: false },
      detect: async () => true,
      read: async () => {
        throw new Error('the tracker is down');
      },
    };
    const report = await readChanges(deps(), [failing, ...CHANGE_SOURCES], { ...ASK, sources: ['broken', 'git'] });
    assert.equal(report.kind, 'report');
    assert.deepEqual(report.kind === 'report' ? report.failed : [], [{ source: 'broken', error: 'the tracker is down' }]);
    const git = new FakeChangeGit(HISTORY, RELEASES);
    git.failure = 'fatal: not a git repository';
    const none = await readChanges(deps({ git }), CHANGE_SOURCES, { ...ASK, since: { kind: 'date', at: '2026-11-16' } });
    assert.deepEqual(none.kind === 'report' ? [none.releases, none.failed] : [], [[], [{ source: 'git', error: 'fatal: not a git repository' }]]);
  });

  it('escapes the control characters and bidi marks outside text holds, keeping its lines', async () => {
    const git = new FakeChangeGit([commitOf('e1000000000', '2026-11-16T13:00:00.000Z', 'feat(cli): a \u202eflag\u001b[2J'), ...HISTORY.slice(1)], RELEASES);
    const report = await reportOf({ since: { kind: 'version', version: '0.3.0' } }, deps({ git }));
    assert.deepEqual(shown(report.entries), ['unreleased feature cli: a \\u202eflag\\x1b[2J']);
    const noted = new MemoryFiles({ '/work/app/changes/a.md': '---\narea: setup\nkind: action\naction: run \u001b]0;x\u0007\n---\nLine one\u001b[1m.\nLine two.\n' });
    const notes = await reportOf({ sources: ['notes'], since: { kind: 'version', version: '0.3.0' } }, deps({ files: noted }));
    assert.deepEqual(
      notes.entries.map((entry) => [entry.text, entry.action]),
      [['Line one\\x1b[1m.\nLine two.', 'run \\x1b]0;x\\x07']],
    );
  });

  it('passes the file and area only to a source that can narrow by them', async () => {
    const asked: (string | undefined)[] = [];
    const narrowing: ChangeSource = {
      id: 'narrow',
      capabilities: { byVersion: true, byDate: true, byFile: false, byArea: true, classified: true },
      detect: async () => true,
      read: async (_, query) => {
        asked.push(query.file, query.area);
        return { kind: 'read', entries: [], warnings: [] };
      },
    };
    await readChanges(deps(), [narrowing], { ...ASK, sources: ['narrow'], file: 'src/', area: 'Open' });
    assert.deepEqual(asked, [undefined, 'open']);
  });
});
