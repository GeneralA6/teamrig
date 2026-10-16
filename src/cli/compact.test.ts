import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonRecord } from '../core/guards.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { RETAIN_DAYS } from '../register/compaction.ts';
import { EVENT_VERSION } from '../register/events.ts';
import { layoutPaths } from '../register/layout.ts';
import { CliHarness, CONFIG_PATH, EVENTS_PATH, TEAM } from '../testing/cli-harness.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { USAGE } from './run.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
const PATHS = layoutPaths(EVENTS_PATH);

/** T1 done and T2 open, three events in a log never rotated, for a team with `config`. */
async function twoTasks(config: JsonRecord = TEAM): Promise<CliHarness> {
  const kit = new CliHarness(config);
  for (const argv of [
    ['add', '--title', 'Old plan', '--description', 'what and why', '--priority', 'p2'],
    ['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none'],
    ['add', '--title', 'Current plan', '--description', 'what and why', '--priority', 'p1'],
  ]) {
    const result = await kit.run(argv, AS_ALPHA);
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
  }
  return kit;
}

/** Every file's text, to show a run wrote nothing. */
function contents(kit: CliHarness): Record<string, string | undefined> {
  return Object.fromEntries(kit.files.paths().map((path) => [path, kit.files.get(path)]));
}

/** The task ids of the rows `list` printed. */
function ids(lines: readonly string[]): string[] {
  return lines.flatMap((line) => /^T\d+(?= )/.exec(line) ?? []);
}

const PLAN = [
  'ARCHIVE events.jsonl (3 event(s), 606 B) as archive/events-000001.jsonl',
  'SNAPSHOT snapshot.jsonl: 3 event(s), 791 B, covering segments 1-1; folded from the history (3 event(s))',
  'TASKS 2 kept (2 unchanged, 0 changed), 0 retired now, 0 before',
  'HISTORY 2 task(s) from 3 event(s): the working set holds every active one as the history does',
  'TAIL events.jsonl starts again with the rotation marker (67 B)',
];

describe('teamrig compact', () => {
  it('prints what it would write on a dry run, and writes nothing', async () => {
    const kit = await twoTasks();
    const before = contents(kit);
    const dry = await kit.run(['compact', '--dry-run'], AS_ALPHA);
    assert.deepEqual([dry.code, dry.stdout, dry.stderr], [EXIT.ok, [...PLAN, 'DRY RUN: nothing was written; teamrig compact writes the above'], []]);
    assert.deepEqual(contents(kit), before);
  });

  it('archives the log whole and reads on from the snapshot; run again with nothing new, it writes nothing', async () => {
    const kit = await twoTasks();
    const log = kit.files.get(EVENTS_PATH);
    const done = await kit.run(['compact'], AS_ALPHA);
    assert.deepEqual([done.code, done.stdout, done.stderr], [EXIT.ok, [...PLAN, 'DONE the tail is archived as archive/events-000001.jsonl; reads start from the new snapshot'], []]);
    assert.equal(kit.files.get(PATHS.segment(1)), log);
    assert.deepEqual(ids((await kit.run(['list'], AS_ALPHA)).stdout), ['T2']);
    const after = contents(kit);
    const again = await kit.run(['compact'], AS_ALPHA);
    assert.deepEqual([again.code, again.stdout.at(-1)], [EXIT.ok, 'NOTHING TO DO: no event since the last rotation and no task to retire; nothing was written']);
    assert.deepEqual(contents(kit), after);
  });

  it('retires a task finished over the retain days, which show and list --status done still find', async () => {
    const kit = await twoTasks();
    assert.equal((await kit.run(['compact'], AS_ALPHA)).code, EXIT.ok);
    kit.clock.advance((RETAIN_DAYS + 1) * MS_PER_DAY);
    const done = await kit.run(['compact'], AS_ALPHA);
    assert.equal(done.stdout[2], 'TASKS 1 kept (1 unchanged, 0 changed), 1 retired now, 0 before');
    assert.equal(done.stdout.at(-1), 'DONE the tail is archived as archive/events-000002.jsonl; reads start from the new snapshot');
    assert.deepEqual(ids((await kit.run(['list'], AS_ALPHA)).stdout), ['T2']);
    assert.deepEqual(ids((await kit.run(['list', '--status', 'all'], AS_ALPHA)).stdout), ['T2', 'T1']);
    assert.deepEqual(ids((await kit.run(['list', '--status', 'done'], AS_ALPHA)).stdout), ['T1']);
    assert.match((await kit.run(['show', 'T1'], AS_ALPHA)).stdout.join('\n'), /Old plan/);
  });

  it('refuses, with nothing written, when the segment it would write holds something else', async () => {
    const kit = await twoTasks();
    await kit.files.write(PATHS.segment(1), 'by hand\n');
    const before = contents(kit);
    const refused = await kit.run(['compact'], AS_ALPHA);
    assert.equal(refused.code, EXIT.failed);
    assert.deepEqual(refused.stderr, [
      `FAILED the rotation is refused, nothing was written: ${PATHS.segment(1)} is there and is not the start of the tail: move it aside by hand, then rotate again`,
    ]);
    assert.equal(refused.stdout[0], 'ARCHIVE events.jsonl (3 event(s), 606 B) as archive/events-000001.jsonl, replacing what a stopped rotation left there');
    assert.deepEqual(contents(kit), before);
  });

  it('names the retain days its help gives', () => {
    assert.ok(USAGE.includes(`finished tasks over ${RETAIN_DAYS} days old leave the working set`));
  });
});

/** Status lines on T2 past the size that makes a write rotate a log rotated before. */
function longTail(): string {
  const line = (status: string) => toJsonlLine({ v: EVENT_VERSION, type: 'status', id: 'T2', at: '2030-01-08T10:00:00.000Z', by: 'alpha', status, note: 'n', evidence: null, skill: null });
  return Array.from({ length: 4_000 }, (_, index) => line(index % 2 === 0 ? 'in-progress' : 'waiting')).join('');
}

/** How the NOTE and WARN lines of a write name the switch that turns automatic archiving off. */
const TURN_OFF = `turn automatic archiving off with register.autoArchive: false in ${CONFIG_PATH}`;

describe('a write on a long tail', () => {
  it('notes the rotation it ran after the write, and the switch that turns it off', async () => {
    const kit = await twoTasks();
    assert.equal((await kit.run(['compact'], AS_ALPHA)).code, EXIT.ok);
    await kit.files.append(EVENTS_PATH, longTail());
    const set = await kit.run(['set', 'T2', '--status', 'in-progress'], AS_ALPHA);
    assert.equal(set.code, EXIT.ok);
    assert.deepEqual(set.stderr, [`NOTE the task list's log is archived as segment 2; 0 finished task(s) left the working set (${TURN_OFF})`]);
    assert.ok(kit.files.get(PATHS.segment(2)) !== undefined);
  });

  it('warns when the rotation fails, names the switch, and keeps the write', async () => {
    const kit = await twoTasks();
    assert.equal((await kit.run(['compact'], AS_ALPHA)).code, EXIT.ok);
    await kit.files.append(EVENTS_PATH, longTail());
    const files = new FaultyFiles(kit.files).fail('createExclusive', PATHS.segment(2), systemError('EACCES'));
    const set = await kit.run(['set', 'T2', '--status', 'in-progress'], { ...AS_ALPHA, files });
    assert.equal(set.code, EXIT.ok);
    assert.deepEqual(set.stderr, [`WARN the write is saved, but archiving the task list's log failed (the next write tries again; ${TURN_OFF}): EACCES: simulated`]);
    assert.equal((await kit.run(['show', 'T2'], AS_ALPHA)).stdout.some((line) => /in-progress/.test(line)), true);
  });

  it('never archives with register.autoArchive false, while compact still archives by hand', async () => {
    const kit = await twoTasks({ ...TEAM, register: { autoArchive: false } });
    assert.equal((await kit.run(['compact'], AS_ALPHA)).code, EXIT.ok);
    await kit.files.append(EVENTS_PATH, longTail());
    const set = await kit.run(['set', 'T2', '--status', 'in-progress'], AS_ALPHA);
    assert.deepEqual([set.code, set.stderr], [EXIT.ok, []]);
    assert.equal(kit.files.get(PATHS.segment(2)), undefined);
    const before = contents(kit);
    const dry = await kit.run(['compact', '--dry-run'], AS_ALPHA);
    assert.deepEqual([dry.code, dry.stdout.at(-1)], [EXIT.ok, 'DRY RUN: nothing was written; teamrig compact writes the above']);
    assert.deepEqual(contents(kit), before);
    const done = await kit.run(['compact'], AS_ALPHA);
    assert.deepEqual([done.code, done.stdout.at(-1)], [EXIT.ok, 'DONE the tail is archived as archive/events-000002.jsonl; reads start from the new snapshot']);
    assert.ok(kit.files.get(PATHS.segment(2)) !== undefined);
  });
});
