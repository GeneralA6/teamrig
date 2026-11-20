import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../../config/load.ts';
import { isRecord, isStringArray, recordField, type JsonRecord } from '../../core/guards.ts';
import { toJsonlLine } from '../../core/jsonl.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { inboxLineOf } from '../../inbox/inbox.ts';
import { lineHash } from '../../inbox/line-hash.ts';
import { layoutPaths } from '../../register/layout.ts';
import { GITHUB_ACTOR } from '../../register/policy.ts';
import { CliHarness, CONFIG_PATH, EVENTS_PATH, TEAM, TEAM_HOME, type CliResult } from '../../testing/cli-harness.ts';
import { rotateRegister } from '../../testing/rotation.ts';
import { teamInboxOf, treeHarness } from '../../testing/team-tree.ts';
import { EXIT } from '../runtime.ts';

const READ_TASKS = ['read', 'tasks', '--json'] as const;
const READ_INBOX = ['read', 'inbox', '--json', '--session', 'alpha'] as const;
const ALPHA_INBOX = teamInboxOf('app', 'alpha');
const INBOX_MARKS = join(TEAM_HOME, 'state', 'inbox-marks.jsonl');
const HOUR_MS = 3_600_000;
const REVISION = /^[0-9a-f]{16}$/;

/** Every stdout line as the JSON object it must be: `read` writes nothing else there. */
function answersOf(result: CliResult): JsonRecord[] {
  return result.stdout.map((line) => {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) {
      throw new Error(`stdout holds a line that is no JSON object: ${line}`);
    }
    return parsed;
  });
}

/** The one document a run that asked for one was answered with, after a clean exit. */
function served(result: CliResult): JsonRecord {
  assert.deepEqual([result.code, result.stderr], [EXIT.ok, []]);
  const answers = answersOf(result);
  const [answer] = answers;
  if (answer === undefined || answers.length !== 1) {
    throw new Error(`one answer was asked and ${answers.length} came`);
  }
  return answer;
}

function tasksOf(answer: JsonRecord): JsonRecord[] {
  const tasks = answer['tasks'];
  if (!Array.isArray(tasks)) {
    throw new Error('the answer has no tasks list');
  }
  return tasks.filter(isRecord);
}

function titlesOf(answer: JsonRecord): unknown[] {
  return tasksOf(answer).map((task) => recordField(task, 'title')?.['text']);
}

function problemsOf(answer: JsonRecord): readonly string[] {
  const problems = answer['problems'];
  if (!isStringArray(problems)) {
    throw new Error('the answer has no problems list');
  }
  return problems;
}

async function add(kit: CliHarness, title: string, owner: string, env: Readonly<Record<string, string>> = {}): Promise<void> {
  const added = await kit.run(['add', '--session', 'lead', '--title', title, '--description', 'what and why', '--priority', 'p2', '--owner', owner], { env });
  assert.equal(added.code, EXIT.ok, added.stderr.join('\n'));
}

/** Rewrites each task the register holds as one an import from outside wrote, with the title given. */
async function importedFrom(kit: CliHarness, source: string, title: string): Promise<void> {
  const lines = (kit.files.get(EVENTS_PATH) ?? '').split('\n').filter((line) => line !== '');
  const rewritten = lines.map((line) => {
    const event: unknown = JSON.parse(line);
    const task = isRecord(event) ? recordField(event, 'task') : undefined;
    return isRecord(event) && task !== undefined ? toJsonlLine({ ...event, task: { ...task, source, title } }) : `${line}\n`;
  });
  await kit.files.write(EVENTS_PATH, rewritten.join(''));
}

/** Posts one inbox line as the CLI does, and gives the line the inbox file then holds. */
async function post(kit: CliHarness, from: string, to: string, text: string): Promise<string> {
  const posted = await kit.run(['inbox', 'add', '--session', from, '--to', to, '--text', text]);
  assert.equal(posted.code, EXIT.ok, posted.stderr.join('\n'));
  return inboxLineOf(new Date(kit.clock.now()), from, text);
}

/** Alpha reads its inbox, which marks every line it holds as read. */
async function markRead(kit: CliHarness): Promise<void> {
  const read = await kit.run(['inbox', 'read', '--session', 'alpha']);
  assert.equal(read.code, EXIT.ok, read.stderr.join('\n'));
}

function linesOf(answer: JsonRecord): JsonRecord[] {
  const lines = answer['lines'];
  if (!Array.isArray(lines)) {
    throw new Error('the answer has no lines list');
  }
  return lines.filter(isRecord);
}

/** Each served line as its words and whether it is unread. */
function wordsOf(answer: JsonRecord): unknown[][] {
  return linesOf(answer).map((line) => [recordField(line, 'text')?.['text'], line['unread']]);
}

/** Every file with its bytes and its stamp, so a rewrite with the same bytes shows too. */
async function storeOf(kit: CliHarness): Promise<(string | undefined)[][]> {
  const rows: (string | undefined)[][] = [];
  for (const path of kit.files.paths()) {
    rows.push([path, kit.files.get(path), await kit.files.stamp(path)]);
  }
  return rows;
}

describe('teamrig read tasks', () => {
  it('answers one JSON line with the envelope and the working set', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const answer = served(await kit.run(READ_TASKS));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['cuts']], ['1.0', 'tasks', [], []]);
    assert.match(String(answer['revision']), REVISION);
    const [task] = tasksOf(answer);
    assert.deepEqual([task?.['id'], task?.['title'], task?.['owner']], ['T1', { text: 'Ship the gate', source: 'team' }, 'alpha']);
    assert.deepEqual(task?.['source'], { kind: 'session', id: 'lead', name: 'app-lead' });
  });

  it('serves an empty register as no task', async () => {
    assert.deepEqual(tasksOf(served(await new CliHarness().run(READ_TASKS))), []);
  });

  it('marks text from outside the team and escapes what a terminal would act on', async () => {
    const kit = new CliHarness();
    await add(kit, 'Placeholder', 'alpha');
    await importedFrom(kit, 'github', 'Fix \u001b[31mred‮ gate');
    const [task] = tasksOf(served(await kit.run(READ_TASKS)));
    assert.deepEqual(task?.['title'], { text: 'Fix \\x1b[31mred\\u202e gate', source: 'outside' });
    assert.deepEqual(task?.['source'], { kind: 'connector', id: 'github', name: 'GitHub' });
  });

  it('cuts a text matching a secret shape and lists the cut, never serving the text', async () => {
    const kit = new CliHarness();
    await add(kit, 'Tidy the zebra gate', 'alpha');
    await kit.files.write(CONFIG_PATH, formatConfig({ ...TEAM, register: { secretPatterns: ['zebra'] } }));
    const shape = new SecretScanner(['zebra']).find('zebra')?.description;
    const result = await kit.run(READ_TASKS);
    const answer = served(result);
    assert.deepEqual(tasksOf(answer)[0]?.['title'], { text: `[cut: ${shape}]`, source: 'team' });
    assert.deepEqual(answer['cuts'], [{ id: 'T1', field: 'title', shape }]);
    assert.equal(result.stdout.join('\n').includes('zebra'), false);
  });

  it('keeps one session\'s tasks with --owner, by id or by name, as one revision', async () => {
    const kit = new CliHarness();
    await add(kit, 'For alpha', 'alpha');
    await add(kit, 'For bravo', 'bravo');
    const all = served(await kit.run(READ_TASKS));
    const byId = served(await kit.run([...READ_TASKS, '--owner', 'alpha']));
    const byName = served(await kit.run([...READ_TASKS, '--owner', 'app-alpha']));
    assert.deepEqual([titlesOf(all), titlesOf(byId), titlesOf(byName)], [['For alpha', 'For bravo'], ['For alpha'], ['For alpha']]);
    assert.equal(byName['revision'], byId['revision']);
    assert.notEqual(byId['revision'], all['revision']);
  });

  it('serves no task for an owner that holds none, a session the team no longer has too', async () => {
    const kit = new CliHarness();
    await add(kit, 'For alpha', 'alpha');
    assert.deepEqual(tasksOf(served(await kit.run([...READ_TASKS, '--owner', 'gone']))), []);
  });

  it('holds its revision until a file it reads changes', async () => {
    const kit = new CliHarness();
    await add(kit, 'First', 'alpha');
    const first = served(await kit.run(READ_TASKS))['revision'];
    assert.equal(served(await kit.run(READ_TASKS))['revision'], first);
    await add(kit, 'Second', 'alpha');
    assert.notEqual(served(await kit.run(READ_TASKS))['revision'], first);
  });

  it('writes no file', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const before = await storeOf(kit);
    served(await kit.run(READ_TASKS));
    assert.deepEqual(await storeOf(kit), before);
  });
});

describe('teamrig read inbox', () => {
  it('serves a session that never read its inbox every line as unread, with no count', async () => {
    const kit = new CliHarness();
    const line = await post(kit, 'lead', 'alpha', 'Ship the gate');
    const answer = served(await kit.run(READ_INBOX));
    assert.deepEqual([answer['interface'], answer['document'], answer['problems'], answer['cuts']], ['1.0', 'inbox', [], []]);
    assert.match(String(answer['revision']), REVISION);
    assert.deepEqual([answer['session'], answer['unread']], [{ id: 'alpha', name: 'app-alpha' }, null]);
    assert.deepEqual(linesOf(answer), [
      { key: lineHash(line), at: '2030-01-08T10:00:00.000Z', from: 'lead', text: { text: 'Ship the gate', source: 'team' }, unread: true },
    ]);
  });

  it('counts the lines posted since the session last read, and still serves the read ones', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    await markRead(kit);
    const read = served(await kit.run(READ_INBOX));
    await post(kit, 'bravo', 'alpha', 'Second');
    const next = served(await kit.run(READ_INBOX));
    assert.deepEqual([read['unread'], wordsOf(read)], [0, [['First', false]]]);
    assert.deepEqual([next['unread'], wordsOf(next)], [1, [['First', false], ['Second', true]]]);
  });

  it('leaves out a read line posted before the last --since hours, its revision not moving with the clock', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    await markRead(kit);
    await post(kit, 'lead', 'alpha', 'Second');
    const fresh = served(await kit.run(READ_INBOX));
    kit.clock.advance(25 * HOUR_MS);
    const later = served(await kit.run(READ_INBOX));
    const wider = served(await kit.run([...READ_INBOX, '--since', '48']));
    const none = served(await kit.run([...READ_INBOX, '--since', '0']));
    assert.deepEqual(
      [wordsOf(fresh), wordsOf(later), wordsOf(wider), wordsOf(none)],
      [[['First', false], ['Second', true]], [['Second', true]], [['First', false], ['Second', true]], [['Second', true]]],
    );
    assert.equal(later['revision'], fresh['revision']);
    assert.equal(new Set([later['revision'], wider['revision'], none['revision']]).size, 3);
  });

  it('answers the same for the session by id, by name and by the session variable, and another for another session', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    const byId = served(await kit.run(READ_INBOX));
    const byName = served(await kit.run(['read', 'inbox', '--json', '--session', 'app-alpha']));
    const byVariable = served(await kit.run(['read', 'inbox', '--json'], { env: { TEAMRIG_SESSION: 'alpha' } }));
    const other = served(await kit.run(['read', 'inbox', '--json', '--session', 'bravo']));
    assert.deepEqual([byName, byVariable], [byId, byId]);
    assert.deepEqual([other['session'], other['lines']], [{ id: 'bravo', name: 'app-bravo' }, []]);
    assert.notEqual(other['revision'], byId['revision']);
  });

  it('marks a line a connector posted as text from outside and escapes what a terminal would act on', async () => {
    const kit = new CliHarness();
    await kit.files.append(ALPHA_INBOX, `${inboxLineOf(new Date(kit.clock.now()), GITHUB_ACTOR, 'Fix \u001b[31mred gate')}\n`);
    const [line] = linesOf(served(await kit.run(READ_INBOX)));
    assert.deepEqual([line?.['from'], line?.['text']], ['github', { text: 'Fix \\x1b[31mred gate', source: 'outside' }]);
  });

  it('cuts a line matching a secret shape and lists the cut under the line\'s key, never serving the words', async () => {
    const kit = new CliHarness();
    const line = await post(kit, 'lead', 'alpha', 'Tidy the zebra gate');
    await kit.files.write(CONFIG_PATH, formatConfig({ ...TEAM, register: { secretPatterns: ['zebra'] } }));
    const shape = new SecretScanner(['zebra']).find('zebra')?.description;
    const result = await kit.run(READ_INBOX);
    const answer = served(result);
    assert.deepEqual(linesOf(answer)[0]?.['text'], { text: `[cut: ${shape}]`, source: 'team' });
    assert.deepEqual(answer['cuts'], [{ id: lineHash(line), field: 'text', shape }]);
    assert.equal(result.stdout.join('\n').includes('zebra'), false);
  });

  it('serves the lines and counts a damaged read mark in problems', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    await markRead(kit);
    await kit.files.append(INBOX_MARKS, '{not json\n');
    const answer = served(await kit.run(READ_INBOX));
    assert.deepEqual([answer['unread'], wordsOf(answer)], [0, [['First', false]]]);
    assert.deepEqual(
      problemsOf(answer).map((problem) => problem.replace(INBOX_MARKS, 'inbox-marks.jsonl')),
      ['inbox-marks.jsonl: 1 unreadable line(s) left out'],
    );
  });

  it('holds its revision until a line is posted to the session or it reads its inbox', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    const first = served(await kit.run(READ_INBOX))['revision'];
    await post(kit, 'lead', 'bravo', 'For bravo');
    assert.equal(served(await kit.run(READ_INBOX))['revision'], first);
    await markRead(kit);
    const read = served(await kit.run(READ_INBOX))['revision'];
    await post(kit, 'lead', 'alpha', 'Second');
    const posted = served(await kit.run(READ_INBOX))['revision'];
    assert.equal(new Set([first, read, posted]).size, 3);
  });

  it('serves an empty inbox for a session the team does not have', async () => {
    const answer = served(await new CliHarness().run(['read', 'inbox', '--json', '--session', 'gone']));
    assert.deepEqual([answer['session'], answer['unread'], answer['lines']], [{ id: 'gone', name: 'gone' }, null, []]);
  });

  it('writes no file, so no line is marked read', async () => {
    const kit = new CliHarness();
    await post(kit, 'lead', 'alpha', 'First');
    const before = await storeOf(kit);
    assert.equal(served(await kit.run(READ_INBOX))['unread'], null);
    assert.deepEqual(await storeOf(kit), before);
  });
});

describe('teamrig read --team', () => {
  const AS_UI = { env: { TEAMRIG_TEAM: 'ui' } };

  it('is a usage error for inbox, which is the asking session\'s own team\'s', async () => {
    const kit = await treeHarness();
    const result = await kit.run(['read', 'inbox', '--json', '--session', 'pixel', '--team', 'web'], AS_UI);
    assert.deepEqual([result.code, result.stdout], [EXIT.usage, []]);
    assert.match(result.stderr.join('\n'), /inbox is the asking session's own, in its own team \(ui\): ask for it without --team/);
  });

  it('serves a team above the caller\'s', async () => {
    const kit = await treeHarness();
    await add(kit, 'Of app', 'alpha');
    await add(kit, 'Of web', 'front', { TEAMRIG_TEAM: 'web' });
    await add(kit, 'Of ui', 'pixel', { TEAMRIG_TEAM: 'ui' });
    const own = served(await kit.run(READ_TASKS, AS_UI));
    const parent = served(await kit.run([...READ_TASKS, '--team', 'web'], AS_UI));
    const root = served(await kit.run([...READ_TASKS, '--team', 'app'], AS_UI));
    assert.deepEqual([titlesOf(own), titlesOf(parent), titlesOf(root)], [['Of ui'], ['Of web'], ['Of app']]);
    assert.equal(new Set([own['revision'], parent['revision'], root['revision']]).size, 3);
  });

  it('refuses a team beside the caller\'s and one below it, on stderr', async () => {
    const kit = await treeHarness();
    const beside = await kit.run([...READ_TASKS, '--team', 'ops'], AS_UI);
    const below = await kit.run([...READ_TASKS, '--team', 'ui'], { env: { TEAMRIG_TEAM: 'web' } });
    assert.deepEqual(
      [beside, below],
      [
        { code: EXIT.refused, stdout: [], stderr: ['REFUSED read serves your own team (ui) and the teams above it; --team ops names neither'] },
        { code: EXIT.refused, stdout: [], stderr: ['REFUSED read serves your own team (web) and the teams above it; --team ui names neither'] },
      ],
    );
  });
});

describe('teamrig read: what is asked', () => {
  const USAGE_ERRORS: readonly (readonly [string, readonly string[], RegExp])[] = [
    ['no document', ['read', '--json'], /read needs a document: tasks, inbox, sessions, meetings, config/],
    ['an unknown document', ['read', 'goals', '--json'], /unknown document "goals"; the documents are tasks, inbox, sessions, meetings, config/],
    ['a document twice', ['read', 'tasks', 'tasks', '--json'], /document tasks is asked twice/],
    ['a document not served yet', ['read', 'tasks', 'sessions', '--json'], /document sessions is not served yet; this teamrig serves tasks, inbox/],
    ['inbox with no session named', ['read', 'inbox', '--json'], /inbox is one session's: name it with --session/],
    ['a --since that is no count of hours', [...READ_INBOX, '--since', 'x'], /--since takes whole hours, such as 24; got "x"/],
    ['no --json', ['read', 'tasks'], /read answers only as JSON in interface 1: add --json/],
    ['a malformed --interface', [...READ_TASKS, '--interface', 'x'], /--interface takes <major\.minor>, such as 1\.0; got "x"/],
  ];

  for (const [what, argv, message] of USAGE_ERRORS) {
    it(`is a usage error, with no document printed, for ${what}`, async () => {
      const result = await new CliHarness().run(argv);
      assert.deepEqual([result.code, result.stdout], [EXIT.usage, []]);
      assert.match(result.stderr.join('\n'), message);
    });
  }

  it('answers the version asked when it serves it', async () => {
    assert.equal(served(await new CliHarness().run([...READ_TASKS, '--interface', '1.0']))['interface'], '1.0');
  });

  for (const version of ['2.0', '0.9', '1.1']) {
    it(`refuses --interface ${version} on stderr and prints no document`, async () => {
      const result = await new CliHarness().run([...READ_TASKS, '--interface', version]);
      assert.deepEqual([result.code, result.stdout, result.stderr.length], [EXIT.refused, [], 1]);
      assert.match(result.stderr.join('\n'), /^REFUSED /);
    });
  }
});

describe('teamrig read: what could not be read', () => {
  it('refuses on stderr, with no document, in a team with no config', async () => {
    const result = await new CliHarness(null).run(READ_TASKS);
    assert.deepEqual([result.code, result.stdout, result.stderr.length], [EXIT.refused, [], 1]);
    assert.match(result.stderr.join('\n'), /^REFUSED /);
  });

  it('carries a config problem in problems, where a text command warns on stderr', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await kit.files.write(CONFIG_PATH, formatConfig({ ...TEAM, pushGuard: { protectedBranches: 'main' } }));
    const answer = served(await kit.run(READ_TASKS));
    assert.equal(problemsOf(answer).length, 1);
    assert.deepEqual(titlesOf(answer), ['Ship the gate']);
  });

  it('serves the tasks it can read and counts a damaged line in problems', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    await kit.files.append(EVENTS_PATH, '{not json\n');
    const answer = served(await kit.run(READ_TASKS));
    assert.deepEqual(titlesOf(answer), ['Ship the gate']);
    assert.deepEqual(
      problemsOf(answer).map((problem) => problem.replace(EVENTS_PATH, 'events.jsonl')),
      ['events.jsonl: 1 unreadable line(s) left out'],
    );
  });

  it('serves no task and says why when an archive segment is gone, changing its revision when it is back', async () => {
    const kit = new CliHarness();
    await add(kit, 'Ship the gate', 'alpha');
    const layout = layoutPaths(EVENTS_PATH);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    const segment = kit.files.get(layout.segment(1)) ?? '';
    await kit.files.remove(layout.snapshot);
    await kit.files.remove(layout.segment(1));
    const broken = served(await kit.run(READ_TASKS));
    assert.deepEqual(tasksOf(broken), []);
    assert.match(problemsOf(broken).join('\n'), /events-000001\.jsonl is missing: the register's archive is incomplete/);
    await kit.files.write(layout.segment(1), segment);
    const whole = served(await kit.run(READ_TASKS));
    assert.deepEqual([titlesOf(whole), problemsOf(whole)], [['Ship the gate'], []]);
    assert.notEqual(whole['revision'], broken['revision']);
  });
});
