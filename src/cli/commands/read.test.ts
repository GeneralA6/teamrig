import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatConfig } from '../../config/load.ts';
import { isRecord, isStringArray, recordField, type JsonRecord } from '../../core/guards.ts';
import { toJsonlLine } from '../../core/jsonl.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { layoutPaths } from '../../register/layout.ts';
import { CliHarness, CONFIG_PATH, EVENTS_PATH, TEAM, type CliResult } from '../../testing/cli-harness.ts';
import { rotateRegister } from '../../testing/rotation.ts';
import { treeHarness } from '../../testing/team-tree.ts';
import { EXIT } from '../runtime.ts';

const READ_TASKS = ['read', 'tasks', '--json'] as const;
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

describe('teamrig read --team', () => {
  const AS_UI = { env: { TEAMRIG_TEAM: 'ui' } };

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
    ['a document not served yet', ['read', 'tasks', 'inbox', '--json'], /document inbox is not served yet; this teamrig serves tasks/],
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
