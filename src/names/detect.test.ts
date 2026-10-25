import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Roster } from '../config/roster.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { renameOf } from '../testing/rename.ts';
import type { TeamRoster } from '../hooks/bind.ts';
import { adoptTitle, promptNote, sessionStartNote, type TitleOutcome } from './detect.ts';
import { JsonlRenameLog } from './log.ts';
import type { RenameDeps } from './record.ts';

const PATH = join('/', 'state', 'renames.jsonl');
const CONFIG = { sessions: ['lead', 'alpha', 'bravo'], names: {}, roles: { lead: 'lead' } };
const BEFORE: TeamRoster = { team: 'app', roster: new Roster(CONFIG, 'app') };

function setup(text?: string): { deps: RenameDeps; mutex: InlineMutex } {
  const mutex = new InlineMutex();
  const deps: RenameDeps = {
    log: new JsonlRenameLog(new MemoryFiles(text === undefined ? {} : { [PATH]: text }), PATH),
    mutex,
    clock: new FakeClock('2030-01-08T10:00:00Z'),
    rosterOf: (renames) => new Roster(CONFIG, 'app', renames),
  };
  return { deps, mutex };
}

describe('adoptTitle', () => {
  it('records a title that is a name but for its case in lowercase', async () => {
    const { deps } = setup();
    const outcome = await adoptTitle(deps, BEFORE, 'alpha', 'Scout');
    assert.ok(outcome.kind === 'recorded');
    assert.equal(outcome.rename.to, 'scout');
  });

  it("records a new title as the session's own rename", async () => {
    const { deps, mutex } = setup();
    const outcome = await adoptTitle(deps, BEFORE, 'alpha', 'scout');
    assert.ok(outcome.kind === 'recorded');
    assert.deepEqual([outcome.rename.from, outcome.rename.to, outcome.rename.by], ['app-alpha', 'scout', 'alpha']);
    assert.equal(mutex.runs, 1);
  });

  it('settles the same name and a refused one without taking the lock', async () => {
    const { deps, mutex } = setup();
    assert.deepEqual(await adoptTitle(deps, BEFORE, 'alpha', 'app-alpha'), { kind: 'unchanged' });
    assert.deepEqual(await adoptTitle(deps, BEFORE, 'alpha', 'alpha'), { kind: 'unchanged' }, 'its id, as a tab titled to bind it');
    assert.deepEqual(await adoptTitle(deps, BEFORE, 'alpha', 'App-Alpha'), { kind: 'unchanged' }, 'its name in another case');
    assert.deepEqual(await adoptTitle(deps, BEFORE, 'alpha', 'Alpha'), { kind: 'unchanged' }, 'its id in another case');
    assert.deepEqual(await adoptTitle(deps, BEFORE, 'alpha', 'Fix the build'), {
      kind: 'refused',
      title: 'Fix the build',
      reason: '"Fix the build" cannot be a session name: a lowercase letter, then lowercase letters, digits or -, at most 65 characters',
    });
    assert.equal(mutex.runs, 0);
  });

  it('decides again under the lock, where a rename recorded meanwhile wins', async () => {
    const taken = setup(JSON.stringify(renameOf('bravo', 'app-bravo', 'scout')));
    assert.deepEqual(await adoptTitle(taken.deps, BEFORE, 'alpha', 'scout'), { kind: 'refused', title: 'scout', reason: 'scout is already the name of bravo' });
    const same = setup(JSON.stringify(renameOf('alpha', 'app-alpha', 'scout')));
    assert.deepEqual(await adoptTitle(same.deps, BEFORE, 'alpha', 'scout'), { kind: 'unchanged' });
  });

  it('reads its own name in the [<team>] <name> form people see as no rename', async () => {
    const { deps, mutex } = setup();
    assert.deepEqual(await adoptTitle(deps, BEFORE, 'alpha', '[app] alpha'), { kind: 'unchanged' }, 'its id');
    assert.deepEqual(await adoptTitle(deps, BEFORE, 'alpha', '[App] App-Alpha'), { kind: 'unchanged' }, 'its name');
    const renamed: TeamRoster = { team: 'app', roster: new Roster(CONFIG, 'app', [renameOf('alpha', 'app-alpha', 'app-scout')]) };
    assert.deepEqual(await adoptTitle(deps, renamed, 'alpha', '[app] scout'), { kind: 'unchanged' }, 'the bare name of app-scout');
    assert.equal(mutex.runs, 0);
  });

  it("records the name in a title bracketing its team, and keeps another team's bracket in the title", async () => {
    const { deps } = setup();
    const outcome = await adoptTitle(deps, BEFORE, 'alpha', '[app] Scout');
    assert.ok(outcome.kind === 'recorded');
    assert.equal(outcome.rename.to, 'scout');
    assert.equal((await adoptTitle(setup().deps, BEFORE, 'alpha', '[web] scout')).kind, 'refused');
  });
});

describe('title notes', () => {
  const recorded: TitleOutcome = { kind: 'recorded', rename: renameOf('alpha', 'app-alpha', 'scout') };
  const quiet: TitleOutcome[] = [{ kind: 'none' }, { kind: 'unchanged' }];

  it('tells a starting session what happened to its title', () => {
    assert.equal(
      sessionStartNote(recorded),
      'This session was renamed in Claude Code, so its team name is now `scout` (was `app-alpha`); the old name still finds it.',
    );
    assert.equal(
      sessionStartNote({ kind: 'refused', title: 'scout', reason: 'scout is already the name of bravo' }),
      'This session\'s Claude Code title "scout" is not its team name: scout is already the name of bravo.',
    );
    assert.equal(
      sessionStartNote({ kind: 'failed', error: 'lock busy' }),
      "This session's Claude Code title could not be checked against its team name (lock busy); the next prompt tries again.",
    );
    assert.deepEqual(quiet.map(sessionStartNote), [undefined, undefined]);
  });

  it('speaks on a prompt only when it recorded a rename', () => {
    assert.equal(promptNote(recorded, 'teamrig'), "teamrig: this session's team name is now `scout` (was `app-alpha`), from its Claude Code title; the old name still finds it.");
    const silent: TitleOutcome[] = [...quiet, { kind: 'refused', title: 'x', reason: 'y' }, { kind: 'failed', error: 'z' }];
    assert.deepEqual(silent.map((outcome) => promptNote(outcome, 'teamrig')), [undefined, undefined, undefined, undefined]);
  });
});
