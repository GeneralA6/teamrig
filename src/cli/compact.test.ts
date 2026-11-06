import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { HOOK_LOG_AGE } from '../core/aged-log.ts';
import { isRecord, type JsonRecord } from '../core/guards.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { MS_PER_DAY } from '../core/time.ts';
import { RETAIN_DAYS } from '../register/compaction.ts';
import { EVENT_VERSION } from '../register/events.ts';
import { layoutPaths } from '../register/layout.ts';
import { CliHarness, CONFIG_PATH, EVENTS_PATH, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
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
    ['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none'],
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

/** A snapshot line as a teamrig that did not parse `evidence` wrote it back: T1's status without it; any other line as it was. */
function withoutEvidence(line: string): string {
  const record: unknown = line === '' ? undefined : JSON.parse(line);
  if (!isRecord(record) || record['id'] !== 'T1' || record['type'] !== 'status') {
    return line;
  }
  return JSON.stringify(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'evidence')));
}

/** The task ids of the rows `list` printed. */
function ids(lines: readonly string[]): string[] {
  return lines.flatMap((line) => /^T\d+(?= )/.exec(line) ?? []);
}

const PLAN = [
  'ARCHIVE events.jsonl (3 event(s), 621 B) as archive/events-000001.jsonl',
  'SNAPSHOT snapshot.jsonl: 3 event(s), 806 B, covering segments 1-1; folded from the history (3 event(s))',
  'TASKS 2 kept (2 unchanged, 0 changed), 0 retired now, 0 before',
  'HISTORY 2 task(s) from 3 event(s): the working set holds every active one as the history does',
  'TAIL events.jsonl starts again with the rotation marker (67 B)',
];

/** The hooks' aged logs, with nothing to archive. */
const NO_AGED = [
  'AGED inbox-shown: no line older than 7 days, 0 kept',
  'AGED bind-hints: no line older than 7 days, 0 kept',
  'AGED prompt-answers: no line older than 7 days, 0 kept',
];
const SHOWN_PATH = join(TEAM_HOME, 'state', 'inbox-shown.jsonl');
const HINTS_PATH = join(TEAM_HOME, 'state', 'bind-hints.jsonl');
const ANSWERS_PATH = join(TEAM_HOME, 'state', 'prompt-answers.jsonl');

describe('teamrig compact', () => {
  it('prints what it would write on a dry run, and writes nothing', async () => {
    const kit = await twoTasks();
    const before = contents(kit);
    const dry = await kit.run(['compact', '--dry-run'], AS_ALPHA);
    assert.deepEqual([dry.code, dry.stdout, dry.stderr], [EXIT.ok, [...PLAN, ...NO_AGED, 'DRY RUN: nothing was written; teamrig compact writes the above'], []]);
    assert.deepEqual(contents(kit), before);
  });

  it('archives the log whole and reads on from the snapshot; run again with nothing new, it writes nothing', async () => {
    const kit = await twoTasks();
    const log = kit.files.get(EVENTS_PATH);
    const done = await kit.run(['compact'], AS_ALPHA);
    assert.deepEqual([done.code, done.stdout, done.stderr], [EXIT.ok, [...PLAN, ...NO_AGED, 'DONE the tail is archived as archive/events-000001.jsonl; reads start from the new snapshot'], []]);
    assert.equal(kit.files.get(PATHS.segment(1)), log);
    assert.deepEqual(ids((await kit.run(['list'], AS_ALPHA)).stdout), ['T2']);
    const after = contents(kit);
    const again = await kit.run(['compact'], AS_ALPHA);
    assert.deepEqual([again.code, again.stdout.at(-1)], [EXIT.ok, 'NOTHING TO DO: no event since the last rotation, no task to retire and no hook record over 7 days old; nothing was written']);
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
    assert.deepEqual(ids((await kit.run(['list', '--status', 'all'], AS_ALPHA)).stdout), ['T1', 'T2']);
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
    assert.equal(refused.stdout[0], 'ARCHIVE events.jsonl (3 event(s), 621 B) as archive/events-000001.jsonl, replacing what a stopped rotation left there');
    assert.deepEqual(contents(kit), before);
  });

  it('rebuilds a snapshot that lost fields from the history with --from-history, where a plain run refuses it and points there', async () => {
    const kit = await twoTasks();
    assert.equal((await kit.run(['compact'], AS_ALPHA)).code, EXIT.ok);
    await kit.files.write(PATHS.snapshot, (kit.files.get(PATHS.snapshot) ?? '').split('\n').map(withoutEvidence).join('\n'));
    const difference = 'T1 folds otherwise in the working set than in the history';
    const refused = await kit.run(['compact', '--dry-run'], AS_ALPHA);
    assert.deepEqual(
      [refused.code, refused.stdout.at(-1), refused.stderr],
      [
        EXIT.failed,
        'HINT the archive holds the whole history: teamrig compact --from-history --dry-run shows a snapshot rebuilt from it',
        [`FAILED the rotation is refused, nothing was written: ${difference}`],
      ],
    );
    const before = contents(kit);
    const dry = await kit.run(['compact', '--from-history', '--dry-run'], AS_ALPHA);
    assert.equal(dry.code, EXIT.ok, dry.stderr.join('\n'));
    assert.deepEqual(dry.stdout.slice(2, 4), [
      'REBUILD from the history in place of the old snapshot: 1 line(s) read again from the archive, 1 difference(s) from the old working set repaired',
      `REPAIR ${difference}`,
    ]);
    assert.deepEqual(contents(kit), before);
    assert.equal((await kit.run(['compact', '--from-history'], AS_ALPHA)).code, EXIT.ok);
    const plain = await kit.run(['compact', '--dry-run'], AS_ALPHA);
    assert.deepEqual([plain.code, plain.stderr], [EXIT.ok, []]);
  });

  it('names the retain days its help gives', () => {
    assert.ok(USAGE.includes(`finished tasks over ${RETAIN_DAYS} days old leave the working set`));
    assert.ok(USAGE.includes(`records over ${HOOK_LOG_AGE.keepDays} days old to the archive`));
  });

  it("plans, then archives, the hooks' records over a week old when the register has nothing to rotate (T336)", async () => {
    const kit = await twoTasks();
    assert.equal((await kit.run(['compact'], AS_ALPHA)).code, EXIT.ok);
    const shownOld = `${JSON.stringify({ v: 1, area: 'alpha', line: 1, at: '2029-12-30T09:00:00.000Z', claudeSession: null, lastLineHash: null })}
`;
    const shownNew = `${JSON.stringify({ v: 1, area: 'alpha', line: 2, at: '2030-01-07T09:00:00.000Z', claudeSession: null, lastLineHash: null })}
`;
    const hintOld = `${JSON.stringify({ v: 1, claudeSession: 'gone', reason: 'untitled', at: '2029-12-31T09:00:00.000Z' })}
`;
    const answerOld = toJsonlLine({ v: 1, at: '2029-12-31T09:00:00.000Z', session: null, claudeSession: null, tool: 'Bash', answer: 'refused', command: 'rm -rf x' });
    await kit.files.write(SHOWN_PATH, shownOld + shownNew);
    await kit.files.write(HINTS_PATH, hintOld);
    await kit.files.write(ANSWERS_PATH, answerOld);
    const aged = [
      'AGED inbox-shown: 1 line(s) older than 7 days to archive/inbox-shown-20300108.jsonl, 1 kept',
      'AGED bind-hints: 1 line(s) older than 7 days to archive/bind-hints-20300108.jsonl, 0 kept',
      'AGED prompt-answers: 1 line(s) older than 7 days to archive/prompt-answers-20300108.jsonl, 0 kept',
    ];
    const before = contents(kit);
    const dry = await kit.run(['compact', '--dry-run'], AS_ALPHA);
    assert.deepEqual(dry.stdout.slice(-4), [...aged, 'DRY RUN: nothing was written; teamrig compact writes the above']);
    assert.deepEqual(contents(kit), before);

    const done = await kit.run(['compact'], AS_ALPHA);
    assert.deepEqual([done.code, done.stdout.slice(-4)], [EXIT.ok, [...aged, 'DONE the hook records over 7 days old are archived; the register had nothing to rotate']]);
    assert.deepEqual(
      [kit.files.get(SHOWN_PATH), kit.files.get(join(TEAM_HOME, 'state', 'archive', 'inbox-shown-20300108.jsonl'))],
      [shownNew, shownOld],
    );
    assert.deepEqual([kit.files.get(HINTS_PATH), kit.files.get(join(TEAM_HOME, 'state', 'archive', 'bind-hints-20300108.jsonl'))], ['', hintOld]);
    assert.deepEqual([kit.files.get(ANSWERS_PATH), kit.files.get(join(TEAM_HOME, 'state', 'archive', 'prompt-answers-20300108.jsonl'))], ['', answerOld]);
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
