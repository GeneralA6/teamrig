import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { recordField, type JsonRecord } from '../../core/guards.ts';
import { toJsonlLine } from '../../core/jsonl.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { cutText, INTERFACE_VERSION } from '../../interface/index.ts';
import { EVENT_WINDOW_DAYS } from '../../register/compaction.ts';
import { TASK_LINE_VERSION } from '../../register/events.ts';
import { layoutPaths } from '../../register/layout.ts';
import { CliHarness, EVENTS_PATH, TEAM_HOME, type RunOptions } from '../../testing/cli-harness.ts';
import { normalisePath } from '../../testing/memory-files.ts';
import { problemsOf, rowsOf, served } from '../../testing/read-answers.ts';
import { rotateRegister } from '../../testing/rotation.ts';
import { treeHarness } from '../../testing/team-tree.ts';
import { WatchedFiles } from '../../testing/watched-files.ts';
import { EXIT } from '../runtime.ts';

const READ_HISTORY = ['read', 'history', '--json'] as const;
const AS_WEB: RunOptions = { env: { TEAMRIG_TEAM: 'web' } };
const AS_UI: RunOptions = { env: { TEAMRIG_TEAM: 'ui' } };
const DAY_MS = 86_400_000;

/** A text the shipped shapes take for a secret, built here so no secret-shaped line sits in the repository. */
const SECRET = ['pass', 'word', '=', 'hunter2'].join('');

async function ok(kit: CliHarness, argv: readonly string[], options: RunOptions = {}): Promise<void> {
  const result = await kit.run(argv, options);
  assert.equal(result.code, EXIT.ok, [...argv, ...result.stdout, ...result.stderr].join(' '));
}

/** Adds a task as the team's lead; the first of a register is T1. */
async function add(kit: CliHarness, title: string, owner: string, options: RunOptions = {}): Promise<void> {
  await ok(kit, ['add', '--session', 'lead', '--title', title, '--description', 'what and why', '--priority', 'p2', '--owner', owner], options);
}

/** Every file with its bytes and its stamp, so a rewrite with the same bytes shows too. */
async function storeOf(kit: CliHarness): Promise<(string | undefined)[][]> {
  const rows: (string | undefined)[][] = [];
  for (const path of kit.files.paths()) {
    rows.push([path, kit.files.get(path), await kit.files.stamp(path)]);
  }
  return rows;
}

async function historyOf(kit: CliHarness, task: string, options: RunOptions = {}, more: readonly string[] = []): Promise<JsonRecord> {
  return served(await kit.run([...READ_HISTORY, '--task', task, ...more], options));
}

function eventsOf(answer: JsonRecord): JsonRecord[] {
  return rowsOf(answer, 'events');
}

/** Each served event as its kind and, for a status event, the status it set. */
function stepsOf(answer: JsonRecord): unknown[] {
  return eventsOf(answer).map((event) => (event['kind'] === 'status' ? event['status'] : event['kind']));
}

async function revisionOf(kit: CliHarness, task: string): Promise<string> {
  return String((await historyOf(kit, task))['revision']);
}

/** T1 added by the lead for alpha, started by alpha, then made more urgent by the lead. */
async function workedTask(): Promise<CliHarness> {
  const kit = new CliHarness();
  await add(kit, 'Ship the gate', 'alpha');
  await ok(kit, ['set', 'T1', '--status', 'in-progress', '--session', 'alpha']);
  await ok(kit, ['update', 'T1', '--priority', 'p1', '--note', 'the release needs it', '--session', 'lead']);
  return kit;
}

/**
 * Rotates the register once its events are older than the window a snapshot keeps, so the working set holds the
 * tasks and none of the events written so far: those are then only in the archive's segment.
 */
async function rotatedPastTheWindow(kit: CliHarness): Promise<void> {
  kit.clock.advance((EVENT_WINDOW_DAYS + 1) * DAY_MS);
  await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
}

describe('teamrig read history', () => {
  it('answers one JSON line with the envelope and each event of the task, in the order written', async () => {
    const kit = await workedTask();
    const now = new Date(kit.clock.now()).toISOString();
    const answer = await historyOf(kit, 'T1');
    assert.deepEqual([answer['interface'], answer['document'], answer['task'], answer['problems'], answer['cuts']], [INTERFACE_VERSION, 'history', 'T1', [], []]);
    assert.match(String(answer['revision']), /^[0-9a-f]{16}$/);
    const [created, started, updated, ...rest] = eventsOf(answer);
    assert.deepEqual(rest, []);
    assert.deepEqual(created, {
      kind: 'create',
      at: now,
      by: 'lead',
      task: {
        title: { text: 'Ship the gate', source: 'team' },
        description: { text: 'what and why', source: 'team' },
        owner: 'alpha',
        priority: 2,
        type: null,
        critical: false,
        due: null,
        source: { kind: 'session', id: 'lead', name: 'app-lead' },
        ref: null,
        goals: [],
        week: null,
        size: null,
        pin: null,
        workClass: null,
        after: [],
      },
    });
    assert.deepEqual(
      [started?.['kind'], started?.['at'], started?.['by'], started?.['status'], started?.['waits'], started?.['followups']],
      ['status', now, 'alpha', 'in-progress', null, null],
    );
    assert.deepEqual(updated, { kind: 'update', at: now, by: 'lead', changes: { priority: 1 }, note: 'the release needs it', verdict: null, waits: null, decided: false });
  });

  it('serves one task’s events and no other’s', async () => {
    const kit = await workedTask();
    await add(kit, 'Write the guide', 'bravo');
    assert.deepEqual(stepsOf(await historyOf(kit, 'T1')), ['create', 'in-progress', 'update']);
    assert.deepEqual(stepsOf(await historyOf(kit, 'T2')), ['create']);
  });

  it('serves no event, and no problem, of an id the register holds no event of', async () => {
    const kit = await workedTask();
    const answer = await historyOf(kit, 'T99');
    assert.deepEqual([answer['task'], answer['events'], answer['problems']], ['T99', [], []]);
  });

  it('refuses, as a usage error, history with no --task, a --task that is no task id, and --task without history', async () => {
    const kit = await workedTask();
    const unnamed = await kit.run(READ_HISTORY);
    const shapeless = await kit.run([...READ_HISTORY, '--task', 'gate']);
    const unasked = await kit.run(['read', 'tasks', '--json', '--task', 'T1']);
    assert.deepEqual([unnamed.code, shapeless.code, unasked.code], [EXIT.usage, EXIT.usage, EXIT.usage]);
    assert.deepEqual([unnamed.stdout, shapeless.stdout, unasked.stdout], [[], [], []]);
    assert.match(unnamed.stderr.join('\n'), /history is one task's: name it with --task T<id>/);
    assert.match(shapeless.stderr.join('\n'), /--task takes a task id, such as T12; got "gate"/);
    assert.match(unasked.stderr.join('\n'), /--task names the task history is asked of, and this run does not ask for history/);
  });

  it('answers history beside the other documents of a run that names the task', async () => {
    const kit = await workedTask();
    const result = await kit.run(['read', 'tasks', 'history', '--json', '--task', 'T1']);
    assert.deepEqual([result.code, result.stderr], [EXIT.ok, []]);
    assert.deepEqual(
      result.stdout.map((line) => line.includes('"document":"history"')),
      [false, true],
    );
  });

  it('serves the whole history of a task whose older events a rotation left to the archive', async () => {
    const kit = await workedTask();
    await rotatedPastTheWindow(kit);
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'no longer wanted', '--session', 'alpha']);
    const answer = await historyOf(kit, 'T1');
    assert.deepEqual([stepsOf(answer), problemsOf(answer)], [['create', 'in-progress', 'update', 'dropped'], []]);
  });

  it('serves the history of a task the working set no longer holds', async () => {
    const kit = await workedTask();
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'no longer wanted', '--session', 'alpha']);
    kit.clock.advance(90 * DAY_MS);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    assert.deepEqual(rowsOf(served(await kit.run(['read', 'tasks', '--json'])), 'tasks'), [], 'the task retired from the working set');
    assert.deepEqual(stepsOf(await historyOf(kit, 'T1')), ['create', 'in-progress', 'update', 'dropped']);
  });

  it('writes no file and no folder reading a task from the archive, served in full or as unchanged', async () => {
    const kit = await workedTask();
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'no longer wanted', '--session', 'alpha']);
    kit.clock.advance(90 * DAY_MS);
    await rotateRegister(kit.files, EVENTS_PATH, { now: new Date(kit.clock.now()) });
    const before = await storeOf(kit);
    const files = new WatchedFiles(kit.files);
    const answer = served(await kit.run([...READ_HISTORY, '--task', 'T1'], { files }));
    assert.equal(stepsOf(answer).length, 4, 'the events came from the archive');
    assert.ok(files.touched().includes(normalisePath(layoutPaths(EVENTS_PATH).segment(1))), 'the archive segment was read');
    const again = served(await kit.run([...READ_HISTORY, '--task', 'T1', '--unless', `history=${String(answer['revision'])}`], { files }));
    assert.equal(again['unchanged'], true);
    assert.deepEqual([files.written(), await storeOf(kit)], [[], before]);
  });

  it('writes no file and no folder in a team that has no state folder yet', async () => {
    const kit = new CliHarness();
    const state = `${normalisePath(join(TEAM_HOME, 'state'))}/`;
    assert.deepEqual(kit.files.paths().filter((path) => path.startsWith(state)), []);
    const before = await storeOf(kit);
    const files = new WatchedFiles(kit.files);
    assert.deepEqual(eventsOf(served(await kit.run([...READ_HISTORY, '--task', 'T1'], { files }))), []);
    assert.deepEqual([files.written(), await storeOf(kit)], [[], before]);
  });

  it('serves no event and says why when an archive segment is gone, changing its revision when it is back', async () => {
    const kit = await workedTask();
    const layout = layoutPaths(EVENTS_PATH);
    await rotatedPastTheWindow(kit);
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'no longer wanted', '--session', 'alpha']);
    const segment = kit.files.get(layout.segment(1)) ?? '';
    await kit.files.remove(layout.segment(1));
    const broken = await historyOf(kit, 'T1');
    const segment1 = normalisePath(layout.segment(1)).slice(normalisePath(TEAM_HOME).length);
    assert.deepEqual(eventsOf(broken), [], 'half a history would read as a whole one');
    assert.deepEqual(problemsOf(broken), [`app${segment1}: missing, so the register's archive is incomplete and the task's history cannot be read`]);
    await kit.files.write(layout.segment(1), segment);
    const whole = await historyOf(kit, 'T1');
    assert.deepEqual([stepsOf(whole).length, problemsOf(whole)], [4, []]);
    assert.notEqual(whole['revision'], broken['revision']);
  });

  it('counts a damaged register line in problems and serves the events it can read', async () => {
    const kit = await workedTask();
    await kit.files.append(EVENTS_PATH, '{not json\n');
    const answer = await historyOf(kit, 'T1');
    assert.deepEqual([stepsOf(answer).length, problemsOf(answer)], [3, ['app/state/events.jsonl: 1 unreadable line(s) left out']]);
  });

  it('serves the history of a task of a team above the caller’s with --team, and its own without', async () => {
    const kit = await treeHarness();
    await add(kit, 'Of web', 'front', AS_WEB);
    await add(kit, 'Of ui', 'pixel', AS_UI);
    const titlesOf = (answer: JsonRecord): unknown[] => eventsOf(answer).map((event) => recordField(recordField(event, 'task') ?? {}, 'title')?.['text']);
    assert.deepEqual(titlesOf(await historyOf(kit, 'T1', AS_UI, ['--team', 'web'])), ['Of web']);
    assert.deepEqual(titlesOf(await historyOf(kit, 'T2', AS_UI)), ['Of ui']);
    assert.deepEqual(titlesOf(await historyOf(kit, 'T1', AS_UI)), [], 'T1 is web’s: a run reads one team’s register');
  });

  it('answers unchanged to a reader holding the revision, whichever owner it names', async () => {
    const kit = await workedTask();
    const held = await revisionOf(kit, 'T1');
    assert.equal(String((await historyOf(kit, 'T1', {}, ['--owner', 'bravo']))['revision']), held);
    const again = served(await kit.run([...READ_HISTORY, '--task', 'T1', '--unless', `history=${held}`]));
    assert.deepEqual(again, { interface: INTERFACE_VERSION, document: 'history', revision: held, unchanged: true });
  });

  it('moves the revision with an event written to the register, and holds a different one for each task', async () => {
    const kit = await workedTask();
    await add(kit, 'Write the guide', 'bravo');
    const first = await revisionOf(kit, 'T1');
    assert.notEqual(await revisionOf(kit, 'T2'), first);
    assert.equal(await revisionOf(kit, 'T1'), first, 'a read moves nothing');
    await ok(kit, ['set', 'T1', '--status', 'dropped', '--note', 'no longer wanted', '--session', 'alpha']);
    assert.notEqual(await revisionOf(kit, 'T1'), first);
  });

  it('cuts a note shaped like a secret, names its event, and never writes the secret out', async () => {
    const kit = await workedTask();
    const shape = new SecretScanner().find(SECRET)?.description;
    assert.ok(shape !== undefined, 'the shipped shapes know the test secret');
    await kit.files.append(EVENTS_PATH, toJsonlLine({ v: TASK_LINE_VERSION, type: 'status', id: 'T1', at: '2030-01-08T11:00:00.000Z', by: 'alpha', status: 'open', note: SECRET, evidence: null, skill: null }));
    const result = await kit.run([...READ_HISTORY, '--task', 'T1']);
    const answer = served(result);
    assert.deepEqual(answer['cuts'], [{ id: 'T1#3', field: 'note', shape }]);
    assert.equal(eventsOf(answer)[3]?.['note'], cutText(shape));
    assert.equal(result.stdout.join('\n').includes(SECRET), false);
  });
});
