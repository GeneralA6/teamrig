import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { Roster } from '../config/roster.ts';
import { TimeZone } from '../core/zone.ts';
import type { Task } from '../register/fold.ts';
import { testTask } from '../testing/task.ts';
import { byReopenOrder, passLineOf, passTotalOf, type PassStep, type ReopenWish } from './idle-pass.ts';

const ROSTER = new Roster({ sessions: ['lead', 'alpha', 'bravo'], names: { alpha: 'api' }, roles: { lead: 'lead' } }, 'app');
const APP = resolve('/', 'work', 'app');
const CLOSABLE = {
  record: { claudePid: 8100, claudeSession: 'c1', at: '2030-01-08T08:00:00.000Z' },
  claude: { pid: 8100, parentPid: 8000, name: 'claude.exe', commandLine: 'claude --resume c1' },
  heldMb: 1300,
  committedMb: undefined,
  idleMinutes: 75,
  folder: APP,
};
const HANDED = { kind: 'handed', tasks: [testTask({ id: 'T5' }), testTask({ id: 'T7' })] } as const;
const DAY_START = { kind: 'day-start', at: Date.parse('2030-01-08T06:00:00.000Z'), tasks: [testTask({ id: 'T2', priority: 3 })] } as const;
const P0 = testTask({ id: 'T12', owner: 'bravo', priority: 0 });
const NEEDED = { kind: 'needed', waiting: [{ task: P0, needs: [testTask({ id: 'T7' })], asks: [{ kind: 'approval', who: 'alpha' }] }] } as const;
const ASKED = { kind: 'asked', asks: [{ from: 'lead', text: 'look now', at: 1000 }], at: 1000 } as const;

function wish(id: string, reopening: ReopenWish['reopening'], top: Task | undefined): ReopenWish {
  return { kind: 'wish', id, reopening, top, project: APP };
}

describe('byReopenOrder', () => {
  it('puts a wish for right-now work before an older urgent line, which still goes before a plain handed task', () => {
    const asked = wish('lead', ASKED, undefined);
    const needed = wish('alpha', NEEDED, P0);
    const handed = wish('bravo', HANDED, testTask({ id: 'T5', priority: 1 }));
    assert.deepEqual([handed, asked, needed].sort(byReopenOrder).map((step) => step.id), ['alpha', 'lead', 'bravo']);
  });

  it('puts a wish whose top task is p0 handed work before an urgent line too', () => {
    const asked = wish('lead', ASKED, undefined);
    const handedP0 = wish('bravo', HANDED, testTask({ id: 'T5', priority: 0 }));
    assert.deepEqual([asked, handedP0].sort(byReopenOrder).map((step) => step.id), ['bravo', 'lead']);
  });
});

describe('passLineOf', () => {
  it('names each step with its session and why', () => {
    const lines: readonly [PassStep, string][] = [
      [{ kind: 'close', id: 'alpha', closable: CLOSABLE, project: APP }, 'CLOSE api (session alpha): quiet 75 min, its Claude Code holds 1300 MB'],
      [{ kind: 'close', id: 'alpha', closable: { ...CLOSABLE, committedMb: 2100 }, project: APP }, 'CLOSE api (session alpha): quiet 75 min, its Claude Code holds 1300 MB, 2100 MB committed'],
      [{ kind: 'keep', id: 'alpha', why: 'api (session alpha) is in a turn' }, 'KEEP api (session alpha) is in a turn'],
      [{ kind: 'reopen', id: 'alpha', reopening: HANDED, project: APP }, 'REOPEN api (session alpha): work handed to it since its close: T5, T7'],
      [{ kind: 'reopen', id: 'bravo', reopening: DAY_START, project: APP }, "REOPEN app-bravo (session bravo): the day's start at 06:00 UTC, with work it can start: T2"],
      [{ kind: 'reopen', id: 'alpha', reopening: NEEDED, project: APP }, 'REOPEN api (session alpha): right-now work of others waiting on it: T12 (p0, owner bravo) waits on your approval, your T7'],
      [{ kind: 'later', id: 'bravo', reopening: HANDED, why: 'api reopens first, one a pass' }, 'LATER app-bravo (session bravo): work handed to it since its close: T5, T7; api reopens first, one a pass'],
      [{ kind: 'closed', id: 'bravo' }, 'CLOSED app-bravo (session bravo): nothing it can start'],
      [{ kind: 'away', id: 'bravo' }, 'AWAY app-bravo (session bravo): not running, and teamrig did not close it'],
    ];
    for (const [step, line] of lines) {
      assert.equal(passLineOf(step, ROSTER, TimeZone.UTC), line);
    }
  });
});

describe('passTotalOf', () => {
  it('counts the steps by kind and says the pass changed nothing', () => {
    const steps: readonly PassStep[] = [
      { kind: 'keep', id: 'lead', why: 'lead (session lead) holds the lead role: teamrig never closes it' },
      { kind: 'close', id: 'alpha', closable: CLOSABLE, project: APP },
      { kind: 'later', id: 'bravo', reopening: HANDED, why: 'no room' },
    ];
    assert.equal(passTotalOf(steps), 'PASS 3 session(s): 1 to close, 0 to reopen, 1 to reopen later, 1 kept open, 0 closed, 0 away; nothing changed');
  });
});
