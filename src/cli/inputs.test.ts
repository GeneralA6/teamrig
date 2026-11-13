import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TimeZone } from '../core/zone.ts';
import { TASK_STATUSES } from '../register/model.ts';
import { JERUSALEM } from '../testing/zone.ts';
import { UsageError } from './args.ts';
import { addInputOf, callerOf, changesOf, criticalOf, deadlineOf, goalsOf, instantOf, listFilterOf, pinOf, priorityOf, sessionRef, setInputOf, sizeOf, statusInputOf, taskIdOf, taskRefOf, typeOf, waitsOf, weekOf, type TypedTimes } from './inputs.ts';

const flags = (entries: Readonly<Record<string, string>>): ReadonlyMap<string, string> => new Map(Object.entries(entries));

/** 2030-01-08 12:00 UTC, in a UTC team: a typed time reads as the stored one. */
const TIMES: TypedTimes = { nowMs: Date.parse('2030-01-08T12:00:00.000Z'), zone: TimeZone.UTC };

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

  it("reads a task as typed: an id, or a team tree roll-up's <team>/<id>", () => {
    assert.deepEqual(taskRefOf('T12'), { team: undefined, id: 'T12' });
    assert.deepEqual(taskRefOf('web/T12'), { team: 'web', id: 'T12' });
    assert.throws(() => taskRefOf('12'), /"12" is not a task id like T12$/);
    for (const text of ['web/12', 'Web/T12', 'web/T12/x', '/T12', 'web/']) {
      assert.throws(() => taskRefOf(text), new RegExp(`^UsageError: "${text}" is not a task id like T12, or web/T12 for a task of team web$`), text);
    }
  });

  it('takes a week as a day only', () => {
    assert.equal(weekOf('2030-01-07'), '2030-01-07');
    assert.throws(() => weekOf('2030-01-07 10:00'), /--week "2030-01-07 10:00" is not a YYYY-MM-DD date/);
  });
});

describe('priorityOf', () => {
  it('reads p<n> as the level', () => {
    assert.deepEqual(['p0', 'p1', 'p2', 'p5', 'p12', 'p99'].map(priorityOf), [0, 1, 2, 5, 12, 99]);
  });

  it('refuses the old tier spelling and a bare level with the spelling to write', () => {
    assert.throws(() => priorityOf('t2'), { name: 'UsageError', message: 'priority "t2" is the old tier spelling: write p2' });
    assert.throws(() => priorityOf('T3'), { name: 'UsageError', message: 'priority "T3" is the old tier spelling: write p3' });
    assert.throws(() => priorityOf('2'), { name: 'UsageError', message: 'priority "2" is not p<n>: write p2' });
    assert.throws(() => priorityOf('0'), { name: 'UsageError', message: 'priority "0" is not p<n>: write p0' });
  });

  it('refuses any other text without a hint', () => {
    for (const text of ['p00', 'p01', 'p100', 'P2', 'p1.5', 't0', 'high', '']) {
      assert.throws(() => priorityOf(text), { name: 'UsageError', message: `priority "${text}" is not p<n>` }, text);
    }
  });
});

describe('addInputOf', () => {
  it('defaults the owner and source to the caller and sets only the fields given', () => {
    assert.deepEqual(addInputOf(flags({ title: 'Ship it', priority: 'p2' }), 'alpha', TIMES), {
      title: 'Ship it',
      owner: 'alpha',
      source: 'alpha',
      priority: 2,
    });
  });

  it('reads every optional field', () => {
    const input = addInputOf(
      flags({ title: 'Ship it', description: 'Users ask for it.', priority: 'p1', owner: 'bravo', source: 'owner', ref: 'msg 4', due: '2030-01-09', goals: 'g1, g2', week: '2030-01-07' }),
      'alpha', TIMES,
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
    assert.throws(() => addInputOf(flags({ priority: 'p1' }), 'alpha', TIMES), /--title is required/);
    assert.throws(() => addInputOf(flags({ title: 'x' }), 'alpha', TIMES), /--priority is required/);
    assert.throws(() => addInputOf(flags({ title: 'x', priority: '1' }), 'alpha', TIMES), /priority "1" is not p<n>: write p1/);
    assert.throws(() => addInputOf(flags({ title: 'x', priority: 'p1', goals: ' , ' }), 'alpha', TIMES), /--goals " , " is an empty list/);
  });

  it('reads --goals none as a task said to serve no goal, never as a tag (T1730)', () => {
    const input = addInputOf(flags({ title: 'x', priority: 'p1', goals: 'none' }), 'alpha', TIMES);
    assert.deepEqual([input.goals, input.noGoal], [[], true]);
    assert.equal(addInputOf(flags({ title: 'x', priority: 'p1', goals: 'A1' }), 'alpha', TIMES).noGoal, undefined, 'tags leave the mark to its default');
  });

  it('reads the tasks it comes after as task ids', () => {
    assert.deepEqual(addInputOf(flags({ title: 'x', priority: 'p2', after: 'T5, T6' }), 'alpha', TIMES).after, ['T5', 'T6']);
    assert.equal(addInputOf(flags({ title: 'x', priority: 'p2' }), 'alpha', TIMES).after, undefined, 'none given leaves it to the default');
    assert.throws(() => addInputOf(flags({ title: 'x', priority: 'p2', after: 'T5,soon' }), 'alpha', TIMES), /"soon" is not a task id like T12/);
  });
});

describe('goalsOf', () => {
  it('reads goal tags, or none alone as no goal at all (T1730)', () => {
    assert.deepEqual(goalsOf('A1, A2.1'), { goals: ['A1', 'A2.1'] });
    assert.deepEqual(goalsOf('none'), { goals: [], noGoal: true });
    assert.deepEqual(goalsOf(' none '), { goals: [], noGoal: true });
  });

  it('refuses none beside a tag, and an empty list', () => {
    assert.throws(() => goalsOf('A1, none'), { name: 'UsageError', message: '--goals "A1, none": none says the task serves no goal, so give it alone or give only the tags' });
    assert.throws(() => goalsOf('none,none'), UsageError);
    assert.throws(() => goalsOf(' , '), /--goals " , " is an empty list/);
  });
});

describe('changesOf', () => {
  it('changes only the fields given', () => {
    assert.deepEqual(changesOf(flags({ title: 'New', priority: 'p3' }), TIMES), { title: 'New', priority: 3 });
    assert.deepEqual(changesOf(flags({ description: 'Why it matters.' }), TIMES), { description: 'Why it matters.' });
    assert.throws(() => changesOf(flags({ priority: 't3' }), TIMES), /priority "t3" is the old tier spelling: write p3/);
  });

  it('clears the description, ref, due date and week with none, and says the task serves no goal with --goals none', () => {
    assert.deepEqual(changesOf(flags({ description: 'none', ref: 'none', due: 'none', goals: 'none', week: 'none' }), TIMES), {
      description: null,
      ref: null,
      due: null,
      goals: [],
      noGoal: true,
      week: null,
    });
  });

  it('names goal tags without the no-goal mark, and refuses none beside a tag (T1730)', () => {
    assert.deepEqual(changesOf(flags({ goals: 'A1, B1' }), TIMES), { goals: ['A1', 'B1'] });
    assert.throws(() => changesOf(flags({ goals: 'A1,none' }), TIMES), UsageError);
  });

  it('plans after tasks, or clears the plan with none', () => {
    assert.deepEqual(changesOf(flags({ after: 'T5,T6' }), TIMES), { after: ['T5', 'T6'] });
    assert.deepEqual(changesOf(flags({ after: 'none' }), TIMES), { after: [] });
  });

  it('sizes a task, or clears its size with none', () => {
    assert.deepEqual(changesOf(flags({ size: '1.5%' }), TIMES), { size: 1.5 });
    assert.deepEqual(changesOf(flags({ size: 'none' }), TIMES), { size: null });
  });

  it('types a task a bug, or a task, which the bug hint reads as typed', () => {
    assert.deepEqual(changesOf(flags({ type: 'bug' }), TIMES), { type: 'bug' });
    assert.deepEqual(changesOf(flags({ type: 'task' }), TIMES), { type: 'task' });
  });
});

describe('typeOf', () => {
  it('reads task and bug as themselves', () => {
    assert.equal(typeOf('task'), 'task');
    assert.equal(typeOf('bug'), 'bug');
  });

  it('refuses any other text, the old problem spelling too', () => {
    for (const text of ['Bug', 'problem', 'critical', 'none', '']) {
      assert.throws(() => typeOf(text), { name: 'UsageError', message: `--type "${text}" is not task|bug` }, text);
    }
  });

  it('reaches add, which leaves it out when not given', () => {
    assert.equal(addInputOf(flags({ title: 'x', priority: 'p2', type: 'bug' }), 'alpha', TIMES).type, 'bug');
    assert.equal(addInputOf(flags({ title: 'x', priority: 'p2' }), 'alpha', TIMES).type, undefined);
  });
});

describe('criticalOf', () => {
  it('marks critical, clears the mark, or changes nothing, and refuses both at once', () => {
    assert.deepEqual(criticalOf(new Set(['critical'])), { critical: true });
    assert.deepEqual(criticalOf(new Set(['not-critical'])), { critical: false });
    assert.deepEqual(criticalOf(new Set()), {});
    assert.throws(() => criticalOf(new Set(['critical', 'not-critical'])), { name: 'UsageError', message: '--critical and --not-critical: give one' });
  });
});

describe('pinOf', () => {
  it('pins by the caller, unpins, or changes nothing, and refuses both at once', () => {
    assert.deepEqual(pinOf(new Set(['pin']), 'lead'), { pin: 'lead' });
    assert.deepEqual(pinOf(new Set(['unpin']), 'lead'), { pin: null });
    assert.deepEqual(pinOf(new Set(), 'lead'), {});
    assert.throws(() => pinOf(new Set(['pin', 'unpin']), 'lead'), /--pin and --unpin: give one/);
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
    assert.deepEqual(statusInputOf(flags({ status: 'done', note: 'shipped', evidence: 'abc123', skill: 'none' }), TIMES), {
      status: 'done',
      note: 'shipped',
      evidence: 'abc123',
      skill: 'none',
    });
    assert.deepEqual(statusInputOf(flags({ status: 'waiting' }), TIMES), { status: 'waiting' });
  });

  it('reads the follow-ups as task ids, none as an empty list, and refuses text that is not a task id', () => {
    assert.deepEqual(statusInputOf(flags({ status: 'done', followups: 'T4, T5' }), TIMES), { status: 'done', followups: ['T4', 'T5'] });
    assert.deepEqual(statusInputOf(flags({ status: 'done', followups: 'none' }), TIMES), { status: 'done', followups: [] });
    assert.throws(() => statusInputOf(flags({ status: 'done', followups: 'T4,next' }), TIMES), /"next" is not a task id like T12/);
  });

  it('reads each typed reason a waiting task waits for, a time keeping its own colon', () => {
    assert.deepEqual(statusInputOf(flags({ status: 'waiting', waits: 'decision:owner, approval:lead,task:T5,time:2030-01-09 12:00' }), TIMES), {
      status: 'waiting',
      waits: [
        { kind: 'decision', who: 'owner' },
        { kind: 'approval', who: 'lead' },
        { kind: 'task', id: 'T5' },
        { kind: 'time', at: '2030-01-09 12:00' },
      ],
    });
    assert.deepEqual(waitsOf('time:2030-01-09', TIMES), [{ kind: 'time', at: '2030-01-09' }]);
  });

  it('refuses a reason of no known kind or with a bad value', () => {
    assert.throws(() => waitsOf('owner', TIMES), /--waits "owner" is not one of decision:<who>, approval:<who>, task:T<id> or time:/);
    assert.throws(() => waitsOf('review:owner', TIMES), /--waits "review:owner" is not one of/);
    assert.throws(() => waitsOf('decision:', TIMES), /--waits "decision:": decision needs who gives it/);
    assert.throws(() => waitsOf('task:5', TIMES), /--waits "task:5": 5 is not a task id like T12/);
    assert.throws(() => waitsOf('time:tomorrow', TIMES), /--waits time: "tomorrow" is not YYYY-MM-DD or a time: HH:MM or YYYY-MM-DD HH:MM in UTC$/);
  });

  it('refuses blocked, naming waiting that replaced it', () => {
    assert.throws(() => statusInputOf(flags({ status: 'blocked' }), TIMES), /^UsageError: --status blocked was replaced by waiting: use --status waiting --waits <reason> \(decision:<who>/);
    assert.throws(() => listFilterOf(flags({ status: 'open,blocked' }), TIMES), /--status blocked was replaced by waiting: use --status waiting$/);
  });

  it('refuses an unknown status', () => {
    assert.throws(() => statusInputOf(flags({ status: 'finished' }), TIMES), /--status "finished" is not open\|/);
  });
});

describe('setInputOf', () => {
  it('reads the status alone without --ask', () => {
    assert.deepEqual(setInputOf(flags({ status: 'verifying', proof: 'the nightly run', due: '2030-01-09' }), TIMES), {
      status: { status: 'verifying', proof: 'the nightly run', due: '2030-01-09' },
      ask: null,
    });
  });

  it('with --ask, takes --text as the work asked for and --due as its due date', () => {
    assert.deepEqual(setInputOf(flags({ status: 'waiting', ask: 'bravo', text: 'Land the schema change', due: '2030-01-10', note: 'needs the column' }), TIMES), {
      status: { status: 'waiting', note: 'needs the column' },
      ask: { owner: 'bravo', title: 'Land the schema change', due: '2030-01-10' },
    });
    assert.deepEqual(setInputOf(flags({ status: 'waiting', ask: 'bravo', text: 'Land it' }), TIMES).ask, { owner: 'bravo', title: 'Land it' });
  });

  it('pairs --ask and --text, and checks the session shape', () => {
    assert.throws(() => setInputOf(flags({ status: 'waiting', ask: 'bravo' }), TIMES), /--ask needs --text "<the work asked for>"/);
    assert.throws(() => setInputOf(flags({ status: 'waiting', ask: 'bravo', text: '  ' }), TIMES), /--ask needs --text/);
    assert.throws(() => setInputOf(flags({ status: 'waiting', text: 'Land it' }), TIMES), /--text goes only with --ask <session>/);
    assert.throws(() => setInputOf(flags({ status: 'waiting', ask: 'no way', text: 'Land it' }), TIMES), /--ask "no way" is not a session id or name/);
  });
});

describe('listFilterOf', () => {
  it('reads no filter as the defaults', () => {
    assert.deepEqual(listFilterOf(flags({}), TIMES), {});
  });

  it('reads every filter', () => {
    const filter = listFilterOf(
      flags({ session: 'bravo', status: 'open,waiting', source: 'owner', priority: 'p1,p2', 'due-before': '2030-01-09 12:00', week: 'none', goal: 'g1', type: 'bug,task' }), TIMES,
    );
    assert.deepEqual(filter, {
      owner: 'bravo',
      statuses: ['open', 'waiting'],
      source: 'owner',
      priorities: [1, 2],
      dueBefore: new Date('2030-01-09T12:00:00Z'),
      week: null,
      goal: 'g1',
      types: ['bug', 'task'],
    });
  });

  it('reads --status all as every status and a week as its day', () => {
    assert.deepEqual(listFilterOf(flags({ status: 'all', week: '2030-01-07' }), TIMES), { statuses: TASK_STATUSES, week: '2030-01-07' });
  });

  it('refuses a malformed deadline or status', () => {
    assert.throws(() => listFilterOf(flags({ 'due-before': 'tomorrow' }), TIMES), /--due-before "tomorrow" is not YYYY-MM-DD/);
    assert.throws(() => listFilterOf(flags({ status: 'open,later' }), TIMES), /--status "later" is not/);
    assert.throws(() => listFilterOf(flags({ type: 'bug,epic' }), TIMES), /--type "epic" is not task\|bug/);
  });
});

describe('statusInputOf: the decision card', () => {
  it('reads the card parts, trimmed, the options split on |', () => {
    const full = flags({ status: 'waiting', waits: 'decision:owner', question: ' Which tier ', options: 'Basic | Pro at 29 ', recommend: 'Basic', default: 'Basic ships' });
    assert.deepEqual(statusInputOf(full, TIMES).card, { question: 'Which tier', options: ['Basic', 'Pro at 29'], recommend: 'Basic', byDefault: 'Basic ships' });
    assert.deepEqual(statusInputOf(flags({ status: 'waiting', waits: 'decision:owner', recommend: 'Pro now' }), TIMES).card, { recommend: 'Pro now' });
    assert.deepEqual(statusInputOf(flags({ status: 'waiting', waits: 'approval:owner', 'why-ask': ' only the owner sees it ' }), TIMES).card, { whyAsk: 'only the owner sees it' });
    assert.equal('card' in statusInputOf(flags({ status: 'waiting', waits: 'decision:owner' }), TIMES), false);
  });

  it('refuses a blank part or an empty choice', () => {
    assert.throws(() => statusInputOf(flags({ status: 'waiting', question: ' ' }), TIMES), /--question needs text/);
    assert.throws(() => statusInputOf(flags({ status: 'waiting', options: 'Basic || Pro' }), TIMES), /--options has an empty choice: separate the choices with \|/);
  });

  it('keeps an escaped \\| inside a choice as a literal |', () => {
    const typed = flags({ status: 'waiting', waits: 'decision:owner', options: "Approve: add the row 'Account \\| D1 \\| Edit' to the token | Decline: keep the token as it is" });
    assert.deepEqual(statusInputOf(typed, TIMES).card?.options, ["Approve: add the row 'Account | D1 | Edit' to the token", 'Decline: keep the token as it is']);
  });

  it('names the choices it split into when one is empty', () => {
    assert.throws(() => statusInputOf(flags({ status: 'waiting', options: 'Basic || Pro' }), TIMES), /split into 3 choices at each \|: "Basic" \/ "" \/ "Pro"; write \\\| for a \| inside a choice/);
  });
});

describe("a typed time in the team's zone", () => {
  /** 2030-01-08 14:00 IST (12:00 UTC) in a Jerusalem team. */
  const LOCAL: TypedTimes = { nowMs: Date.parse('2030-01-08T12:00:00.000Z'), zone: JERUSALEM };

  it('stores a typed due minute in UTC and keeps a bare day as typed', () => {
    assert.equal(addInputOf(flags({ title: 'Ship it', priority: 'p2', due: '2030-01-09 09:00' }), 'alpha', LOCAL).due, '2030-01-09 07:00');
    assert.equal(addInputOf(flags({ title: 'Ship it', priority: 'p2', due: '2030-01-09' }), 'alpha', LOCAL).due, '2030-01-09', 'a bare day is a day of the zone, stored as is');
    assert.equal(changesOf(flags({ due: '16:30' }), LOCAL).due, '2030-01-08 14:30', 'HH:MM is today there');
    assert.equal(deadlineOf('--due', '2030-01-09 09:00 UTC', LOCAL), '2030-01-09 09:00', 'a time marked UTC is read as UTC');
    assert.equal(deadlineOf('--due', '2030-01-09 09:00 IST', LOCAL), '2030-01-09 07:00', "a time marked with the zone's name is read there");
  });

  it('reads a wait time and a verify-by due there', () => {
    assert.deepEqual(waitsOf('time:2030-01-09 12:00', LOCAL), [{ kind: 'time', at: '2030-01-09 10:00' }]);
    assert.equal(statusInputOf(flags({ status: 'verifying', proof: 'the nightly run', due: '2030-01-09 08:00' }), LOCAL).due, '2030-01-09 06:00');
  });

  it('ends a --due-before day at midnight there', () => {
    assert.equal(listFilterOf(flags({ 'due-before': '2030-01-09' }), LOCAL).dueBefore?.toISOString(), '2030-01-09T21:59:59.999Z');
    assert.equal(listFilterOf(flags({ 'due-before': '2030-01-09 12:00' }), LOCAL).dueBefore?.toISOString(), '2030-01-09T10:00:00.000Z');
  });

  it('reads --since on the clock there', () => {
    assert.equal(instantOf('--since', '09:00', LOCAL), Date.parse('2030-01-08T07:00:00.000Z'));
    assert.equal(instantOf('--since', '09:00', TIMES), Date.parse('2030-01-08T09:00:00.000Z'));
  });

  it("refuses a time it cannot read, naming the zone's clock", () => {
    assert.throws(() => deadlineOf('--due', 'soon', LOCAL), /^UsageError: --due "soon" is not YYYY-MM-DD or a time: HH:MM or YYYY-MM-DD HH:MM in Asia\/Jerusalem \(IST\), or marked UTC$/);
    assert.throws(() => deadlineOf('--due', '2030-01-09 09:00 IDT', LOCAL), /is not YYYY-MM-DD or a time/, 'January is IST there: an IDT mark is refused');
    assert.throws(() => instantOf('--since', 'soon', LOCAL), /--since "soon" is not a time: HH:MM or YYYY-MM-DD HH:MM in Asia\/Jerusalem \(IST\), or marked UTC; YYYY-MM-DD \(its start\) or an ISO time with its zone/);
  });
});
