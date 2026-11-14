import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FlagKind } from '../register/check.ts';
import type { Task } from '../register/fold.ts';
import { TaskTree } from '../register/tree.ts';
import { TimeZone } from '../core/zone.ts';
import { CliHarness } from '../testing/cli-harness.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { testTask } from '../testing/task.ts';
import { CHECK_SEEN_FORMAT, checkKeys, checkSeenOf, formatCheckSeen, newFlags, newSinceLine, parseCheckSeen } from './check-seen.ts';
import type { CheckReport } from './reports.ts';
import { EXIT } from './runtime.ts';

const NOW = Date.parse('2030-01-08T12:00:00.000Z');
const TREE = new TaskTree(new Map(), new Date(NOW), TimeZone.UTC);

function taskFlag(kind: FlagKind, task: Partial<Task>, detail = 'due 01-07'): CheckReport['sections'][number]['flags'][number] {
  return { kind, task: testTask(task), detail };
}

function report(overrides: Partial<CheckReport>): CheckReport {
  return { sections: [], scope: 'week 2030-01-07', skills: [], skillsDir: 'skills-dir', hires: [], unowned: [], lead: 'lead', decisions: undefined, ...overrides };
}

const FULL = report({
  sections: [{ team: undefined, tree: TREE, flags: [taskFlag('OVERDUE', { id: 'T1' }), taskFlag('NO-PROGRESS', { id: 'T2' })] }],
  skills: [{ kind: 'UNVERIFIED', skill: 'alpha-deploy', owner: 'alpha', detail: 'Last verified 2029-11-01' }],
  hires: [{ kind: 'RETIRE-DUE', session: 'helper', detail: 'burst over', action: 'teamrig hire retire helper' }],
  unowned: [{ key: 'context CLAUDE.md', source: 'doctor', text: 'WARN CLAUDE.md over budget' }],
});

describe('checkKeys and newFlags (T2536)', () => {
  it('keys each flag by its kind and what it is on, so a changed detail is the same flag', () => {
    const keys = checkKeys(FULL);
    assert.deepEqual([...keys], ['task OVERDUE T1', 'task NO-PROGRESS T2', 'skill UNVERIFIED alpha-deploy', 'hire RETIRE-DUE helper', 'unowned context CLAUDE.md']);
    const later = report({ sections: [{ team: undefined, tree: TREE, flags: [taskFlag('OVERDUE', { id: 'T1' }, 'due 01-05, 3 days late')] }] });
    assert.deepEqual([...checkKeys(later)], ['task OVERDUE T1']);
  });

  it("names a roll-up's task by its team, so web/T1 is not the own team's T1", () => {
    const rolled = report({ sections: [{ team: 'web', tree: TREE, flags: [taskFlag('OVERDUE', { id: 'T1' })] }] });
    assert.deepEqual([...checkKeys(rolled)], ['task OVERDUE web/T1']);
    assert.equal(newFlags(rolled, new Set(['task OVERDUE T1'])).sections[0]?.flags.length, 1);
  });

  it('keeps only the flags the seen set lacks, of every kind, and the rest of the report as it was', () => {
    const seen = new Set(['task OVERDUE T1', 'skill UNVERIFIED alpha-deploy', 'unowned context CLAUDE.md']);
    const fresh = newFlags(FULL, seen);
    assert.deepEqual(fresh.sections[0]?.flags.map((flag) => flag.task.id), ['T2']);
    assert.deepEqual(fresh.skills, []);
    assert.deepEqual(fresh.hires.map((flag) => flag.session), ['helper']);
    assert.deepEqual(fresh.unowned, []);
    assert.equal(fresh.scope, FULL.scope);
    assert.equal(fresh.lead, FULL.lead);
  });

  it('shows the same kind on another task, and another kind on the same task, as new', () => {
    const fresh = newFlags(FULL, new Set(['task OVERDUE T2', 'task NO-PROGRESS T1']));
    assert.deepEqual(fresh.sections[0]?.flags.map((flag) => `${flag.kind} ${flag.task.id}`), ['OVERDUE T1', 'NO-PROGRESS T2']);
  });
});

describe('the seen file', () => {
  it('reads back what it wrote', () => {
    const seen = { at: NOW, keys: new Set(['task OVERDUE T1', 'hire RETIRE-DUE helper']) };
    assert.deepEqual(parseCheckSeen(formatCheckSeen(seen)), seen);
  });

  it('reads damaged text or another format as nothing seen', () => {
    assert.equal(parseCheckSeen('not json'), undefined);
    assert.equal(parseCheckSeen(JSON.stringify({ v: CHECK_SEEN_FORMAT + 1, at: '2030-01-08T12:00:00.000Z', keys: [] })), undefined);
    assert.equal(parseCheckSeen(JSON.stringify({ v: CHECK_SEEN_FORMAT, at: 'yesterday', keys: [] })), undefined);
    assert.equal(parseCheckSeen(JSON.stringify({ v: CHECK_SEEN_FORMAT, at: '2030-01-08T12:00:00.000Z', keys: [1] })), undefined);
  });

  it('replaces the set on each record, so a flag that cleared and came back is new again', async () => {
    const files = new MemoryFiles();
    const store = checkSeenOf(files, { checkSeen: join('/', 'team', 'state', 'check-seen') }, 'alpha');
    assert.equal(await store.read(), undefined);
    await store.record(FULL, NOW);
    await store.record(report({}), NOW + 1);
    const after = await store.read();
    assert.equal(after?.at, NOW + 1);
    assert.equal(after?.keys.size, 0);
    assert.equal(newFlags(FULL, after?.keys ?? new Set()).sections[0]?.flags.length, 2);
    assert.notEqual(await files.read(join('/', 'team', 'state', 'check-seen', 'alpha.json')), undefined);
  });

  it("names since when, or that nothing was recorded yet, on the team's clock", () => {
    assert.equal(newSinceLine('alpha', { at: NOW, keys: new Set() }, TimeZone.UTC), `NEW since ${TimeZone.UTC.weekdayMinute(new Date(NOW))}, the last start or check --new of alpha (check --all: every flag)`);
    assert.equal(newSinceLine('alpha', undefined, TimeZone.UTC), 'NEW every flag: no start or check --new of alpha recorded what it showed yet');
  });
});

/** Adds an overdue task owned by `owner`, which every check flags OVERDUE. */
async function addOverdue(kit: CliHarness, owner: string, title: string): Promise<void> {
  const added = await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--due', '2030-01-07', '--owner', owner, '--session', 'lead']);
  assert.equal(added.code, EXIT.ok, added.stdout.join('\n'));
}

/** The task ids of the OVERDUE rows a long-form check printed. */
function overdueIds(stdout: readonly string[]): string[] {
  return stdout.filter((line) => line.startsWith('OVERDUE')).flatMap((line) => /\b(T\d+)\b/.exec(line)?.slice(1, 2) ?? []);
}

describe('runCli: check --new (T2536)', () => {
  it("prints only the flags the session's start did not show, then none on the next call", async () => {
    const kit = new CliHarness();
    await addOverdue(kit, 'alpha', 'Seen at the start');
    assert.equal((await kit.run(['start', '--session', 'alpha'])).code, EXIT.ok);
    await addOverdue(kit, 'alpha', 'Raised after the start');
    const first = await kit.run(['check', '--new', '--all', '--session', 'alpha']);
    assert.equal(first.code, EXIT.ok, first.stderr.join('\n'));
    assert.match(first.stdout[0] ?? '', /^NEW since .+, the last start or check --new of alpha \(check --all: every flag\)$/);
    assert.deepEqual(overdueIds(first.stdout), ['T2']);
    const second = await kit.run(['check', '--new', '--all', '--session', 'alpha']);
    assert.deepEqual(overdueIds(second.stdout), []);
    assert.deepEqual(overdueIds((await kit.run(['check', '--all', '--session', 'alpha'])).stdout), ['T1', 'T2'], 'check --all keeps the full view');
  });

  it("narrows a worker's flags to its own, as its start does", async () => {
    const kit = new CliHarness();
    await addOverdue(kit, 'alpha', 'Alpha task');
    await addOverdue(kit, 'bravo', 'Bravo task');
    const own = await kit.run(['check', '--new', '--all', '--session', 'alpha']);
    assert.equal(own.stdout[0], 'NEW every flag: no start or check --new of alpha recorded what it showed yet');
    assert.deepEqual(overdueIds(own.stdout), ['T1']);
    assert.deepEqual(overdueIds((await kit.run(['check', '--new', '--all', '--session', 'lead'])).stdout), ['T1', 'T2'], 'the lead acts on every flag');
  });

  it('leaves the seen set alone on a plain check, which stays a read', async () => {
    const kit = new CliHarness();
    await addOverdue(kit, 'alpha', 'Alpha task');
    assert.deepEqual(overdueIds((await kit.run(['check', '--all', '--session', 'alpha'])).stdout), ['T1']);
    const after = await kit.run(['check', '--new', '--all', '--session', 'alpha']);
    assert.equal(after.stdout[0], 'NEW every flag: no start or check --new of alpha recorded what it showed yet');
    assert.deepEqual(overdueIds(after.stdout), ['T1']);
  });
});
