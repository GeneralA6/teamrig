import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_STATUSES } from '../register/model.ts';
import { UsageError } from './args.ts';
import { addInputOf, callerOf, changesOf, listFilterOf, sessionName, statusInputOf, taskIdOf, weekOf } from './inputs.ts';

const flags = (entries: Readonly<Record<string, string>>): ReadonlyMap<string, string> => new Map(Object.entries(entries));

describe('names and ids', () => {
  it('takes the caller from --session, else the session variable', () => {
    assert.equal(callerOf(flags({ session: 'alpha' }), { TEAMRIG_SESSION: 'bravo' }), 'alpha');
    assert.equal(callerOf(flags({}), { TEAMRIG_SESSION: ' bravo ' }), 'bravo');
    assert.throws(() => callerOf(flags({}), { TEAMRIG_SESSION: '  ' }), UsageError);
    assert.throws(() => callerOf(flags({}), {}), /--session \(or \$TEAMRIG_SESSION\) is required/);
  });

  it('refuses a malformed session name or task id', () => {
    assert.throws(() => sessionName('--to', 'Alpha'), /--to "Alpha" is not a session name/);
    assert.throws(() => callerOf(flags({ session: '9lives' }), {}), UsageError);
    assert.equal(taskIdOf('T12'), 'T12');
    assert.throws(() => taskIdOf('12'), /"12" is not a task id like T12/);
  });

  it('takes a week as a day only', () => {
    assert.equal(weekOf('2030-01-07'), '2030-01-07');
    assert.throws(() => weekOf('2030-01-07 10:00'), /--week "2030-01-07 10:00" is not a YYYY-MM-DD date/);
  });
});

describe('addInputOf', () => {
  it('defaults the owner and source to the caller and sets only the fields given', () => {
    assert.deepEqual(addInputOf(flags({ title: 'Ship it', tier: '2' }), 'alpha'), {
      title: 'Ship it',
      owner: 'alpha',
      source: 'alpha',
      tier: 2,
    });
  });

  it('reads every optional field', () => {
    const input = addInputOf(
      flags({ title: 'Ship it', tier: '1', owner: 'bravo', source: 'owner', ref: 'msg 4', due: '2030-01-09', goals: 'g1, g2', week: '2030-01-07' }),
      'alpha',
    );
    assert.deepEqual(input, {
      title: 'Ship it',
      owner: 'bravo',
      source: 'owner',
      tier: 1,
      ref: 'msg 4',
      due: '2030-01-09',
      goals: ['g1', 'g2'],
      week: '2030-01-07',
    });
  });

  it('refuses a missing title, a tier that is not a whole number and an empty goal list', () => {
    assert.throws(() => addInputOf(flags({ tier: '1' }), 'alpha'), /--title is required/);
    assert.throws(() => addInputOf(flags({ title: 'x', tier: '1.5' }), 'alpha'), /--tier "1.5" is not a whole number/);
    assert.throws(() => addInputOf(flags({ title: 'x', tier: '1', goals: ' , ' }), 'alpha'), /--goals " , " is an empty list/);
  });
});

describe('changesOf', () => {
  it('changes only the fields given', () => {
    assert.deepEqual(changesOf(flags({ title: 'New', tier: '3' })), { title: 'New', tier: 3 });
  });

  it('clears the ref, due date, goals and week with none', () => {
    assert.deepEqual(changesOf(flags({ ref: 'none', due: 'none', goals: 'none', week: 'none' })), {
      ref: null,
      due: null,
      goals: [],
      week: null,
    });
  });
});

describe('statusInputOf', () => {
  it('reads the status and its optional proof', () => {
    assert.deepEqual(statusInputOf(flags({ status: 'done', note: 'shipped', evidence: 'abc123', skill: 'none' })), {
      status: 'done',
      note: 'shipped',
      evidence: 'abc123',
      skill: 'none',
    });
    assert.deepEqual(statusInputOf(flags({ status: 'blocked' })), { status: 'blocked' });
  });

  it('refuses an unknown status', () => {
    assert.throws(() => statusInputOf(flags({ status: 'finished' })), /--status "finished" is not open\|/);
  });
});

describe('listFilterOf', () => {
  it('reads no filter as the defaults', () => {
    assert.deepEqual(listFilterOf(flags({})), {});
  });

  it('reads every filter', () => {
    const filter = listFilterOf(
      flags({ session: 'bravo', status: 'open,blocked', source: 'owner', tier: '1,2', 'due-before': '2030-01-09 12:00', week: 'none', goal: 'g1' }),
    );
    assert.deepEqual(filter, {
      owner: 'bravo',
      statuses: ['open', 'blocked'],
      source: 'owner',
      tiers: [1, 2],
      dueBefore: new Date('2030-01-09T12:00:00Z'),
      week: null,
      goal: 'g1',
    });
  });

  it('reads --status all as every status and a week as its day', () => {
    assert.deepEqual(listFilterOf(flags({ status: 'all', week: '2030-01-07' })), { statuses: TASK_STATUSES, week: '2030-01-07' });
  });

  it('refuses a malformed deadline or status', () => {
    assert.throws(() => listFilterOf(flags({ 'due-before': 'tomorrow' })), /--due-before "tomorrow" is not YYYY-MM-DD/);
    assert.throws(() => listFilterOf(flags({ status: 'open,later' })), /--status "later" is not/);
  });
});
