import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_STATUSES } from '../register/model.ts';
import { UsageError } from './args.ts';
import { addInputOf, callerOf, changesOf, listFilterOf, priorityOf, sessionRef, setInputOf, sizeOf, statusInputOf, taskIdOf, waitsOf, weekOf } from './inputs.ts';

const flags = (entries: Readonly<Record<string, string>>): ReadonlyMap<string, string> => new Map(Object.entries(entries));

describe('names and ids', () => {
  it('takes the caller from --session, else the session variable', () => {
    assert.equal(callerOf(flags({ session: 'alpha' }), { TEAMRIG_SESSION: 'bravo' }), 'alpha');
    assert.equal(callerOf(flags({}), { TEAMRIG_SESSION: ' bravo ' }), 'bravo');
    assert.throws(() => callerOf(flags({}), { TEAMRIG_SESSION: '  ' }), UsageError);
    assert.throws(() => callerOf(flags({}), {}), /--session \(or \$TEAMRIG_SESSION\) is required/);
  });

  it('refuses a malformed session name or task id', () => {
    assert.throws(() => sessionRef('--to', 'Alpha'), /--to "Alpha" is not a session id or name/);
    assert.equal(sessionRef('--to', 'app-a-name-longer-than-thirty-two-characters'), 'app-a-name-longer-than-thirty-two-characters');
    assert.throws(() => callerOf(flags({ session: '9lives' }), {}), UsageError);
    assert.equal(taskIdOf('T12'), 'T12');
    assert.throws(() => taskIdOf('12'), /"12" is not a task id like T12/);
  });

  it('takes a week as a day only', () => {
    assert.equal(weekOf('2030-01-07'), '2030-01-07');
    assert.throws(() => weekOf('2030-01-07 10:00'), /--week "2030-01-07 10:00" is not a YYYY-MM-DD date/);
  });
});

describe('priorityOf', () => {
  it('reads p<n> as the level', () => {
    assert.deepEqual(['p1', 'p2', 'p5', 'p12', 'p99'].map(priorityOf), [1, 2, 5, 12, 99]);
  });

  it('refuses the old tier spelling and a bare level with the spelling to write', () => {
    assert.throws(() => priorityOf('t2'), { name: 'UsageError', message: 'priority "t2" is the old tier spelling: write p2' });
    assert.throws(() => priorityOf('T3'), { name: 'UsageError', message: 'priority "T3" is the old tier spelling: write p3' });
    assert.throws(() => priorityOf('2'), { name: 'UsageError', message: 'priority "2" is not p<n>: write p2' });
  });

  it('refuses any other text without a hint', () => {
    for (const text of ['p0', 'p100', 'P2', 'p1.5', '0', 't0', 'high', '']) {
      assert.throws(() => priorityOf(text), { name: 'UsageError', message: `priority "${text}" is not p<n>` }, text);
    }
  });
});

describe('addInputOf', () => {
  it('defaults the owner and source to the caller and sets only the fields given', () => {
    assert.deepEqual(addInputOf(flags({ title: 'Ship it', priority: 'p2' }), 'alpha'), {
      title: 'Ship it',
      owner: 'alpha',
      source: 'alpha',
      priority: 2,
    });
  });

  it('reads every optional field', () => {
    const input = addInputOf(
      flags({ title: 'Ship it', description: 'Users ask for it.', priority: 'p1', owner: 'bravo', source: 'owner', ref: 'msg 4', due: '2030-01-09', goals: 'g1, g2', week: '2030-01-07' }),
      'alpha',
    );
    assert.deepEqual(input, {
      title: 'Ship it',
      description: 'Users ask for it.',
      owner: 'bravo',
      source: 'owner',
      priority: 1,
      ref: 'msg 4',
      due: '2030-01-09',
      goals: ['g1', 'g2'],
      week: '2030-01-07',
    });
  });

  it('refuses a missing title or priority, a priority that is not p<n> and an empty goal list', () => {
    assert.throws(() => addInputOf(flags({ priority: 'p1' }), 'alpha'), /--title is required/);
    assert.throws(() => addInputOf(flags({ title: 'x' }), 'alpha'), /--priority is required/);
    assert.throws(() => addInputOf(flags({ title: 'x', priority: '1' }), 'alpha'), /priority "1" is not p<n>: write p1/);
    assert.throws(() => addInputOf(flags({ title: 'x', priority: 'p1', goals: ' , ' }), 'alpha'), /--goals " , " is an empty list/);
  });

  it('reads the tasks it comes after as task ids', () => {
    assert.deepEqual(addInputOf(flags({ title: 'x', priority: 'p2', after: 'T5, T6' }), 'alpha').after, ['T5', 'T6']);
    assert.equal(addInputOf(flags({ title: 'x', priority: 'p2' }), 'alpha').after, undefined, 'none given leaves it to the default');
    assert.throws(() => addInputOf(flags({ title: 'x', priority: 'p2', after: 'T5,soon' }), 'alpha'), /"soon" is not a task id like T12/);
  });
});

describe('changesOf', () => {
  it('changes only the fields given', () => {
    assert.deepEqual(changesOf(flags({ title: 'New', priority: 'p3' })), { title: 'New', priority: 3 });
    assert.deepEqual(changesOf(flags({ description: 'Why it matters.' })), { description: 'Why it matters.' });
    assert.throws(() => changesOf(flags({ priority: 't3' })), /priority "t3" is the old tier spelling: write p3/);
  });

  it('clears the description, ref, due date, goals and week with none', () => {
    assert.deepEqual(changesOf(flags({ description: 'none', ref: 'none', due: 'none', goals: 'none', week: 'none' })), {
      description: null,
      ref: null,
      due: null,
      goals: [],
      week: null,
    });
  });

  it('plans after tasks, or clears the plan with none', () => {
    assert.deepEqual(changesOf(flags({ after: 'T5,T6' })), { after: ['T5', 'T6'] });
    assert.deepEqual(changesOf(flags({ after: 'none' })), { after: [] });
  });

  it('sizes a task, or clears its size with none', () => {
    assert.deepEqual(changesOf(flags({ size: '1.5%' })), { size: 1.5 });
    assert.deepEqual(changesOf(flags({ size: 'none' })), { size: null });
  });
});

describe('sizeOf', () => {
  it('reads a percent of the weekly limit, with or without a % sign', () => {
    assert.equal(sizeOf('1.5'), 1.5);
    assert.equal(sizeOf('2%'), 2);
    assert.equal(sizeOf('.5'), 0.5);
    assert.equal(sizeOf(' 100 '), 100);
  });

  it('refuses a size that is not above 0 and at most the whole week', () => {
    for (const text of ['0', '0%', '100.5', '-1', '1e2', 'abc', '', '1.5%%', 'Infinity']) {
      assert.throws(() => sizeOf(text), /--size ".*" is not a percent of the weekly limit above 0 and at most 100, like 1\.5/, text);
    }
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
    assert.deepEqual(statusInputOf(flags({ status: 'waiting' })), { status: 'waiting' });
  });

  it('reads each typed reason a waiting task waits for, a time keeping its own colon', () => {
    assert.deepEqual(statusInputOf(flags({ status: 'waiting', waits: 'decision:owner, approval:lead,task:T5,time:2030-01-09 12:00' })), {
      status: 'waiting',
      waits: [
        { kind: 'decision', who: 'owner' },
        { kind: 'approval', who: 'lead' },
        { kind: 'task', id: 'T5' },
        { kind: 'time', at: '2030-01-09 12:00' },
      ],
    });
    assert.deepEqual(waitsOf('time:2030-01-09'), [{ kind: 'time', at: '2030-01-09' }]);
  });

  it('refuses a reason of no known kind or with a bad value', () => {
    assert.throws(() => waitsOf('owner'), /--waits "owner" is not one of decision:<who>, approval:<who>, task:T<id> or time:/);
    assert.throws(() => waitsOf('review:owner'), /--waits "review:owner" is not one of/);
    assert.throws(() => waitsOf('decision:'), /--waits "decision:": decision needs who gives it/);
    assert.throws(() => waitsOf('task:5'), /--waits "task:5": 5 is not a task id like T12/);
    assert.throws(() => waitsOf('time:tomorrow'), /--waits "time:tomorrow": tomorrow is not YYYY-MM-DD or YYYY-MM-DD HH:MM/);
  });

  it('refuses blocked, naming waiting that replaced it', () => {
    assert.throws(() => statusInputOf(flags({ status: 'blocked' })), /^UsageError: --status blocked was replaced by waiting: use --status waiting --waits <reason> \(decision:<who>/);
    assert.throws(() => listFilterOf(flags({ status: 'open,blocked' })), /--status blocked was replaced by waiting: use --status waiting$/);
  });

  it('refuses an unknown status', () => {
    assert.throws(() => statusInputOf(flags({ status: 'finished' })), /--status "finished" is not open\|/);
  });
});

describe('setInputOf', () => {
  it('reads the status alone without --ask', () => {
    assert.deepEqual(setInputOf(flags({ status: 'verifying', proof: 'the nightly run', due: '2030-01-09' })), {
      status: { status: 'verifying', proof: 'the nightly run', due: '2030-01-09' },
      ask: null,
    });
  });

  it('with --ask, takes --text as the work asked for and --due as its due date', () => {
    assert.deepEqual(setInputOf(flags({ status: 'waiting', ask: 'bravo', text: 'Land the schema change', due: '2030-01-10', note: 'needs the column' })), {
      status: { status: 'waiting', note: 'needs the column' },
      ask: { owner: 'bravo', title: 'Land the schema change', due: '2030-01-10' },
    });
    assert.deepEqual(setInputOf(flags({ status: 'waiting', ask: 'bravo', text: 'Land it' })).ask, { owner: 'bravo', title: 'Land it' });
  });

  it('pairs --ask and --text, and checks the session shape', () => {
    assert.throws(() => setInputOf(flags({ status: 'waiting', ask: 'bravo' })), /--ask needs --text "<the work asked for>"/);
    assert.throws(() => setInputOf(flags({ status: 'waiting', ask: 'bravo', text: '  ' })), /--ask needs --text/);
    assert.throws(() => setInputOf(flags({ status: 'waiting', text: 'Land it' })), /--text goes only with --ask <session>/);
    assert.throws(() => setInputOf(flags({ status: 'waiting', ask: 'no way', text: 'Land it' })), /--ask "no way" is not a session id or name/);
  });
});

describe('listFilterOf', () => {
  it('reads no filter as the defaults', () => {
    assert.deepEqual(listFilterOf(flags({})), {});
  });

  it('reads every filter', () => {
    const filter = listFilterOf(
      flags({ session: 'bravo', status: 'open,waiting', source: 'owner', priority: 'p1,p2', 'due-before': '2030-01-09 12:00', week: 'none', goal: 'g1' }),
    );
    assert.deepEqual(filter, {
      owner: 'bravo',
      statuses: ['open', 'waiting'],
      source: 'owner',
      priorities: [1, 2],
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
