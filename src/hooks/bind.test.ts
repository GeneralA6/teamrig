import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Roster } from '../config/roster.ts';
import { PlainLogFile } from '../core/log-file.ts';
import { lineHash } from '../inbox/line-hash.ts';
import type { InboxMark } from '../inbox/marks.ts';
import { JsonlMarkLog } from '../inbox/store.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { renameOf } from '../testing/rename.ts';
import type { RefreshState } from '../refresh/state.ts';
import {
  bindByEnv,
  bindByProcess,
  bindByTitle,
  bindHint,
  bindMarkOf,
  boundPromptNote,
  boundStartNote,
  hintReason,
  PROCESS_BIND_MAX_AGE_MS,
  processBoundNote,
  refreshedIn,
  sessionsTitled,
  tabDisplayOf,
  tabTitleFor,
  type BindInput,
  type BindOutcome,
  type TeamRoster,
} from './bind.ts';

const MARKS = 'state/inbox-marks.jsonl';
const TAB = '0a1b2c3d-1111-2222-3333-444455556666';
const OTHER_TAB = '9f8e7d6c-1111-2222-3333-444455556666';
const NOW = new Date('2030-01-08T10:00:00Z');
const CONFIG = { sessions: ['lead', 'alpha', 'bravo'], names: { lead: 'captain' }, roles: { lead: 'lead' } };
const OWN: TeamRoster = { team: 'app', roster: new Roster(CONFIG, 'app', [renameOf('bravo', 'app-bravo', 'scout')]) };
const WEB: TeamRoster = { team: 'web', roster: new Roster({ sessions: ['lead', 'docs'], names: {}, roles: { lead: 'lead' } }, 'web') };

function markLine(mark: InboxMark): string {
  return `${JSON.stringify(mark)}\n`;
}

function readMark(area: string, line: number, lastLine: string, claudeSession: string | null): InboxMark {
  return { v: 1, area, line, at: '2030-01-07T09:00:00.000Z', claudeSession, lastLineHash: lineHash(lastLine) };
}

/** A mark log in memory, and a tree reader that counts its reads. */
function setup(marks: readonly InboxMark[] = [], tree: readonly TeamRoster[] = []): { files: MemoryFiles; deps: Parameters<typeof bindByTitle>[0]; treeReads: () => number } {
  const files = new MemoryFiles(marks.length === 0 ? {} : { [MARKS]: marks.map(markLine).join('') });
  let reads = 0;
  const treeTeams = (): Promise<readonly TeamRoster[]> => {
    reads += 1;
    return Promise.resolve(tree);
  };
  return { files, deps: { marks: new JsonlMarkLog(new PlainLogFile(files, MARKS)), treeTeams }, treeReads: () => reads };
}

function input(title: string | undefined, fields: Partial<BindInput> = {}): BindInput {
  return { own: OWN, claudeSession: TAB, envSession: false, title, now: NOW, ...fields };
}

describe('tabTitleFor', () => {
  it("gives an untitled tab its session's current name", () => {
    assert.equal(tabTitleFor(OWN.roster, 'lead', undefined), 'captain');
    assert.equal(tabTitleFor(OWN.roster, 'bravo', undefined), 'scout');
    assert.equal(tabTitleFor(OWN.roster, 'alpha', undefined), 'app-alpha');
  });

  it('gives nothing to a tab with a title or with no session', () => {
    assert.equal(tabTitleFor(OWN.roster, 'alpha', 'Fix the login'), undefined);
    assert.equal(tabTitleFor(OWN.roster, undefined, undefined), undefined);
  });

  it('falls back to the id for a session the roster does not name', () => {
    assert.equal(tabTitleFor(OWN.roster, 'zulu', undefined), 'zulu');
  });
});

describe('tabDisplayOf', () => {
  it('shows a topic naming one session of the team as [<team>] <name>', () => {
    assert.equal(tabDisplayOf(OWN, 'app-alpha'), '[app] alpha');
    assert.equal(tabDisplayOf(OWN, 'Captain'), '[app] captain');
    assert.equal(tabDisplayOf(OWN, '[app] scout'), '[app] scout');
  });

  it('keeps any other topic as it is', () => {
    assert.equal(tabDisplayOf(OWN, 'fix the build'), 'fix the build');
    assert.equal(tabDisplayOf(OWN, '[web] lead'), '[web] lead');
    const odd = { team: 'odd', roster: new Roster({ sessions: ['b', 'c'], names: { c: 'b-two' }, roles: { lead: 'b' } }, 'odd', [renameOf('c', 'b-two', 'b')]) };
    assert.equal(tabDisplayOf(odd, 'b'), 'b', 'a topic naming two sessions');
  });
});

describe('sessionsTitled', () => {
  it('matches an id or a current name, never a former name or a near miss', () => {
    assert.deepEqual(sessionsTitled(OWN, 'alpha'), ['alpha']);
    assert.deepEqual(sessionsTitled(OWN, 'captain'), ['lead']);
    assert.deepEqual(sessionsTitled(OWN, 'scout'), ['bravo']);
    assert.deepEqual(sessionsTitled(OWN, 'app-bravo'), [], 'a former name');
    assert.deepEqual(sessionsTitled(OWN, 'app-alpha '), []);
  });

  it('matches whatever the case of the title', () => {
    assert.deepEqual(sessionsTitled(OWN, 'Alpha'), ['alpha']);
    assert.deepEqual(sessionsTitled(OWN, 'CAPTAIN'), ['lead']);
    assert.deepEqual(sessionsTitled(OWN, 'App-Bravo'), [], 'a former name');
  });

  it('matches the [<team>] <name> form people see, whatever its case, by id, name or bare name', () => {
    assert.deepEqual(sessionsTitled(OWN, '[app] alpha'), ['alpha']);
    assert.deepEqual(sessionsTitled(OWN, '[app] app-alpha'), ['alpha']);
    assert.deepEqual(sessionsTitled(OWN, '[App] Captain'), ['lead']);
    assert.deepEqual(sessionsTitled(OWN, '[app] scout'), ['bravo']);
    assert.deepEqual(sessionsTitled(OWN, '[app] app-bravo'), [], 'a former name');
    const renamed: TeamRoster = { team: 'app', roster: new Roster(CONFIG, 'app', [renameOf('alpha', 'app-alpha', 'app-scout')]) };
    assert.deepEqual(sessionsTitled(renamed, '[app] scout'), ['alpha'], 'the bare name of app-scout');
    assert.deepEqual(sessionsTitled(renamed, 'scout'), [], 'without the team, scout is no name of the team');
  });

  it("matches none of the team's sessions for a title bracketing another team", () => {
    assert.deepEqual(sessionsTitled(OWN, '[web] lead'), []);
    assert.deepEqual(sessionsTitled(WEB, '[web] lead'), ['lead']);
    assert.deepEqual(sessionsTitled(WEB, '[app] lead'), []);
  });
});

describe('bindMarkOf', () => {
  it("repeats the area's newest read position under the new Claude Code session", () => {
    const newest = readMark('alpha', 2, 'second', 'someone');
    assert.deepEqual(bindMarkOf(newest, 'alpha', TAB, NOW), { ...newest, claudeSession: TAB });
  });

  it('starts an area never read before its first line, dated now', () => {
    assert.deepEqual(bindMarkOf(undefined, 'alpha', TAB, NOW), { v: 1, area: 'alpha', line: 0, at: NOW.toISOString(), claudeSession: TAB, lastLineHash: null });
  });
});

describe('bindByEnv', () => {
  it("marks the tab at the area's newest read position, so nothing counts as read", async () => {
    const { files, deps } = setup([readMark('alpha', 4, 'fourth', OTHER_TAB)]);
    const mark = readMark('alpha', 4, 'fourth', TAB);
    assert.deepEqual(await bindByEnv(deps.marks, 'alpha', TAB, NOW), mark);
    assert.equal(await files.read(MARKS), `${markLine(readMark('alpha', 4, 'fourth', OTHER_TAB))}${markLine(mark)}`);
  });

  it('starts an area never read before its first line', async () => {
    const { deps } = setup();
    assert.deepEqual(await bindByEnv(deps.marks, 'alpha', TAB, NOW), bindMarkOf(undefined, 'alpha', TAB, NOW));
  });

  it('writes nothing for a tab a mark names, as this session or another', async () => {
    for (const area of ['alpha', 'bravo']) {
      const { files, deps } = setup([readMark(area, 1, 'first', TAB)]);
      assert.equal(await bindByEnv(deps.marks, 'alpha', TAB, NOW), undefined);
      assert.equal(await files.read(MARKS), markLine(readMark(area, 1, 'first', TAB)));
    }
  });
});

describe('refreshedIn', () => {
  const ready = (claudePid: number | null, at: string = '2030-01-08T09:00:00.000Z'): RefreshState => ({ phase: 'ready', task: 'T3', at, tokens: null, noticed: true, transcript: null, claudePid });

  it('names the sessions whose handover is ready and was announced in this process within the day', () => {
    const states = new Map<string, RefreshState | undefined>([
      ['alpha', ready(6900)],
      ['bravo', ready(6800)],
      ['lead', ready(null)],
      ['old', ready(6900, new Date(NOW.getTime() - PROCESS_BIND_MAX_AGE_MS).toISOString())],
      ['done', { phase: 'refreshed', task: 'T3', at: '2030-01-08T09:00:00.000Z' }],
      ['none', undefined],
    ]);
    assert.deepEqual(refreshedIn(states, 6900, NOW), ['alpha'], 'a reused process id of a session that never came back binds nothing');
  });
});

describe('bindByProcess', () => {
  it("binds the cleared tab to the one session that refreshed in its process, at that area's read position", async () => {
    const { files, deps } = setup([readMark('alpha', 4, 'fourth', OTHER_TAB)]);
    const bound = await bindByProcess({ marks: deps.marks, refreshedHere: () => Promise.resolve(['alpha']) }, TAB, NOW);
    const mark: InboxMark = { ...readMark('alpha', 4, 'fourth', TAB) };
    assert.deepEqual(bound, { id: 'alpha', mark });
    assert.equal(await files.read(MARKS), `${markLine(readMark('alpha', 4, 'fourth', OTHER_TAB))}${markLine(mark)}`);
    assert.match(processBoundNote('alpha'), /^This tab was bound to the `alpha` session: \/clear kept the Claude Code process/);
  });

  it('binds nothing when no session or two refreshed in the process', async () => {
    for (const sessions of [[], ['alpha', 'bravo']]) {
      const { files, deps } = setup();
      assert.equal(await bindByProcess({ marks: deps.marks, refreshedHere: () => Promise.resolve(sessions) }, TAB, NOW), undefined);
      assert.equal(await files.read(MARKS), undefined);
    }
  });
});

describe('bindByTitle', () => {
  it('binds by id or current name, copying the read position, and writes one mark', async () => {
    const position = readMark('alpha', 2, 'second', OTHER_TAB);
    const { files, deps, treeReads } = setup([position], [WEB]);
    const outcome = await bindByTitle(deps, input(' alpha '));
    assert.deepEqual(outcome, { kind: 'bound', id: 'alpha', mark: { ...position, claudeSession: TAB } });
    assert.equal(files.get(MARKS)?.trim().split('\n').length, 2);
    assert.equal(treeReads(), 1);

    const byName = setup();
    assert.equal((await bindByTitle(byName.deps, input('captain'))).kind, 'bound');
    assert.match(byName.files.get(MARKS) ?? '', /"area":"lead","line":0/);
  });

  it('keeps a tab that $TEAMRIG_SESSION or a mark on the roster already names, writing nothing', async () => {
    const env = setup();
    assert.deepEqual(await bindByTitle(env.deps, input('alpha', { envSession: true })), { kind: 'kept' });
    const marked = setup([readMark('bravo', 1, 'x', TAB)]);
    assert.deepEqual(await bindByTitle(marked.deps, input('alpha')), { kind: 'kept' });
    assert.equal(env.files.get(MARKS), undefined);
    assert.equal(marked.files.get(MARKS)?.trim().split('\n').length, 1);
  });

  it('binds over a mark whose area left the roster', async () => {
    const { deps } = setup([readMark('gone', 1, 'x', TAB)]);
    assert.equal((await bindByTitle(deps, input('alpha'))).kind, 'bound');
  });

  it('binds nothing without a title, or with a title that names no session, and never reads the tree for those', async () => {
    const { files, deps, treeReads } = setup([], [WEB]);
    assert.deepEqual(await bindByTitle(deps, input(undefined)), { kind: 'untitled' });
    assert.deepEqual(await bindByTitle(deps, input('   ')), { kind: 'untitled' });
    assert.deepEqual(await bindByTitle(deps, input('Fix the build')), { kind: 'unmatched', title: 'Fix the build' });
    assert.deepEqual(await bindByTitle(deps, input('docs')), { kind: 'unmatched', title: 'docs' }, "another team's session never binds");
    assert.deepEqual([files.get(MARKS), treeReads()], [undefined, 0]);
  });

  it('binds nothing when the title names a session of another team of the tree too', async () => {
    const { files, deps } = setup([], [WEB]);
    assert.deepEqual(await bindByTitle(deps, input('lead')), {
      kind: 'ambiguous',
      title: 'lead',
      candidates: [
        { team: 'app', id: 'lead' },
        { team: 'web', id: 'lead' },
      ],
    });
    assert.equal(files.get(MARKS), undefined);
  });

  it('binds a title bracketing the team to its session alone, where the bare name would be ambiguous', async () => {
    const { deps } = setup([], [WEB]);
    const outcome = await bindByTitle(deps, input('[app] lead'));
    assert.ok(outcome.kind === 'bound');
    assert.equal(outcome.id, 'lead');
    assert.deepEqual(await bindByTitle(setup([], [WEB]).deps, input('[web] lead')), { kind: 'unmatched', title: '[web] lead' });
  });

  it('binds nothing when the title is one session\'s id and another\'s name', async () => {
    const odd = { team: 'odd', roster: new Roster({ sessions: ['b', 'c'], names: { c: 'b-two' }, roles: { lead: 'b' } }, 'odd', [renameOf('c', 'b-two', 'b')]) };
    const { deps } = setup();
    const outcome = await bindByTitle(deps, input('b', { own: odd }));
    assert.equal(outcome.kind, 'ambiguous');
  });
});

describe('the notes and the hint', () => {
  const bound: BindOutcome = { kind: 'bound', id: 'alpha', mark: bindMarkOf(undefined, 'alpha', TAB, NOW) };

  it('names the session a tab was bound to', () => {
    assert.equal(
      boundPromptNote(bound, OWN, 'teamrig'),
      'teamrig: this tab is now the `alpha` session of team app (name `app-alpha`), from its Claude Code title; nothing was marked read.',
    );
    assert.equal(boundStartNote(bound), 'This tab was bound to the `alpha` session from its Claude Code title; nothing was marked read.');
    assert.equal(boundPromptNote({ kind: 'kept' }, OWN, 'teamrig'), undefined);
    assert.equal(boundStartNote({ kind: 'untitled' }), undefined);
  });

  it('says once per reason how to bind a tab that is not bound', () => {
    const outcomes: BindOutcome[] = [
      { kind: 'kept' },
      bound,
      { kind: 'untitled' },
      { kind: 'unmatched', title: 'Fix it' },
      { kind: 'ambiguous', title: 'lead', candidates: [{ team: 'app', id: 'lead' }, { team: 'web', id: 'lead' }] },
      { kind: 'failed', error: 'EBUSY' },
    ];
    assert.deepEqual(outcomes.map(hintReason), [undefined, undefined, 'untitled', 'unmatched:Fix it', 'ambiguous:lead', 'failed']);
    assert.deepEqual(outcomes.map((outcome) => bindHint(outcome, OWN, 'teamrig')), [
      undefined,
      undefined,
      "teamrig: this tab is not bound to a session of team app. To bind it, /rename the tab to its session's id or name, or run `teamrig inbox read --session <id>` (ids: lead, alpha, bravo).",
      'teamrig: this tab\'s title "Fix it" names no session of team app, so it is not bound. To bind it, /rename the tab to its session\'s id or name, or run `teamrig inbox read --session <id>` (ids: lead, alpha, bravo).',
      'teamrig: this tab\'s title "lead" names app/lead and web/lead, so it is not bound. To bind it, /rename the tab to the session\'s name (`teamrig who` lists them), or run `teamrig inbox read --session <id>`.',
      'teamrig: this tab could not be bound by its title (EBUSY); the next prompt tries again.',
    ]);
  });
});
