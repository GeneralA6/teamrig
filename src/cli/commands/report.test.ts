import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliHarness, type CliResult } from '../../testing/cli-harness.ts';
import { EXIT } from '../runtime.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
}

async function addTask(kit: CliHarness, title: string, fields: readonly string[]): Promise<void> {
  ok(await kit.run(['add', '--title', title, '--description', 'what and why', ...fields, '--session', 'lead']));
}

async function finish(kit: CliHarness, id: string, owner: string): Promise<void> {
  ok(await kit.run(['set', id, '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', owner]));
}

/**
 * The harness's team on its UTC clock: on Tue 01-08 the lead files one task for each done group and bravo finishes
 * T7; on Wed 01-09 alpha and bravo finish T1-T5 and alpha drops T6; the report runs on Thu 01-10.
 */
async function seeded(): Promise<CliHarness> {
  const kit = new CliHarness();
  await addTask(kit, 'Login', ['--priority', 'p1', '--owner', 'alpha']);
  await addTask(kit, 'Docs', ['--priority', 'p2', '--owner', 'bravo', '--goals', 'A1']);
  await addTask(kit, 'Pricing', ['--priority', 'p3', '--owner', 'alpha', '--source', 'owner']);
  await addTask(kit, 'Cleanup', ['--priority', 'p3', '--owner', 'bravo', '--week', '2030-01-07']);
  await addTask(kit, 'Tidy', ['--priority', 'p3', '--owner', 'alpha']);
  await addTask(kit, 'Crash', ['--priority', 'p2', '--owner', 'alpha', '--type', 'bug']);
  await addTask(kit, 'Early', ['--priority', 'p3', '--owner', 'bravo']);
  await finish(kit, 'T7', 'bravo');
  kit.clock.advance(DAY_MS);
  await finish(kit, 'T1', 'alpha');
  await finish(kit, 'T2', 'bravo');
  await finish(kit, 'T3', 'alpha');
  await finish(kit, 'T4', 'bravo');
  await finish(kit, 'T5', 'alpha');
  ok(await kit.run(['set', 'T6', '--status', 'dropped', '--note', 'not a bug', '--session', 'alpha']));
  kit.clock.advance(DAY_MS);
  return kit;
}

const GROUPED = [
  '  Owner asked (1)',
  '    T3 done, Improvements, p3, owner alpha | Pricing',
  '  A1 (1)',
  '    T2 done, Improvements, p2, owner bravo | Docs',
  '  Urgent p1 (1)',
  '    T1 done, Improvements, p1, owner alpha | Login',
  "  This week's plan (1)",
  '    T4 done, Improvements, p3, owner bravo | Cleanup',
];

describe('teamrig report done', () => {
  it("prints yesterday's done work in its groups, other work and dropped as one line, writing nothing", async () => {
    const kit = await seeded();
    const before = kit.files.paths().map((path) => [path, kit.files.get(path)]);
    assert.deepEqual(await kit.run(['report', 'done']), {
      code: EXIT.ok,
      stdout: [
        'DONE Wed 01-09 · 5 done · 1 dropped',
        ...GROUPED,
        '  Other work (1) and dropped (1): teamrig report done --day 2030-01-09 --all',
      ],
      stderr: [],
    });
    assert.deepEqual(kit.files.paths().map((path) => [path, kit.files.get(path)]), before);
  });

  it('prints the rows of other work and dropped with --all', async () => {
    const kit = await seeded();
    assert.deepEqual((await kit.run(['report', 'done', '--all'])).stdout, [
      'DONE Wed 01-09 · 5 done · 1 dropped',
      ...GROUPED,
      '  Other work (1)',
      '    T5 done, Improvements, p3, owner alpha | Tidy',
      '  Dropped (1)',
      '    T6 dropped, Improvements, p2, bug, owner alpha | Crash',
    ]);
  });

  it('reads the day --day names, naming only the side that holds a task', async () => {
    const kit = await seeded();
    assert.deepEqual((await kit.run(['report', 'done', '--day', '2030-01-08'])).stdout, [
      'DONE Tue 01-08 · 1 done · 0 dropped',
      '  Other work (1): teamrig report done --day 2030-01-08 --all',
    ]);
    assert.deepEqual((await kit.run(['report', 'done', '--day', '2030-01-10'])).stdout, ['DONE Thu 01-10 · 0 done · 0 dropped']);
  });

  it("reads one owner's tasks with --session, and its --all line keeps the session", async () => {
    const kit = await seeded();
    assert.deepEqual((await kit.run(['report', 'done', '--session', 'alpha'])).stdout, [
      'DONE Wed 01-09 · alpha · 3 done · 1 dropped',
      '  Owner asked (1)',
      '    T3 done, Improvements, p3, owner alpha | Pricing',
      '  Urgent p1 (1)',
      '    T1 done, Improvements, p1, owner alpha | Login',
      '  Other work (1) and dropped (1): teamrig report done --day 2030-01-09 --session alpha --all',
    ]);
    assert.deepEqual((await kit.run(['report', 'done', '--session', 'bravo', '--day', '2030-01-09'])).stdout.slice(0, 1), ['DONE Wed 01-09 · bravo · 2 done · 0 dropped']);
  });

  it('refuses a --day that is not a YYYY-MM-DD date', async () => {
    const kit = await seeded();
    for (const day of ['2030-02-30', '01-09', 'yesterday']) {
      const result = await kit.run(['report', 'done', '--day', day]);
      assert.equal(result.code, EXIT.usage);
      assert.deepEqual(result.stdout, []);
      assert.match(result.stderr.join('\n'), new RegExp(`^--day "${day}" is not a YYYY-MM-DD date`));
    }
  });

  it("bounds the day by the team's zone: a task done at 23:30 UTC is the next day in Jerusalem", async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Late', ['--priority', 'p3', '--owner', 'alpha']);
    kit.clock.advance(DAY_MS + 13 * HOUR_MS + 30 * 60 * 1000);
    await finish(kit, 'T1', 'alpha');
    kit.clock.advance(12 * HOUR_MS + 30 * 60 * 1000);
    const utc = await kit.run(['report', 'done']);
    const jerusalem = await kit.run(['report', 'done'], { timeZone: 'Asia/Jerusalem' });
    const next = await kit.run(['report', 'done', '--day', '2030-01-10'], { timeZone: 'Asia/Jerusalem' });
    assert.deepEqual([utc.stdout[0], jerusalem.stdout[0], next.stdout[0]], [
      'DONE Wed 01-09 · 1 done · 0 dropped',
      'DONE Wed 01-09 · 0 done · 0 dropped',
      'DONE Thu 01-10 · 1 done · 0 dropped',
    ]);
  });
});
