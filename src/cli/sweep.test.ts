import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { readEvents } from '../register/snapshot.ts';
import { formatSweepRows, parseSweepFile, type SweepRow } from '../register/sweep.ts';
import { APP, CliHarness, EVENTS_PATH, type CliResult } from '../testing/cli-harness.ts';
import { SUB_TEAMS, teamConfigOf, teamEventsOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const FILE = join(APP, 'sweep.jsonl');
const WEB = { env: { TEAMRIG_TEAM: 'web' } };
const OPS = { env: { TEAMRIG_TEAM: 'ops' } };
const UI = { env: { TEAMRIG_TEAM: 'ui' } };

function ok(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
}

/** `session` adds itself a p2 task titled `title`. */
async function addTask(kit: CliHarness, title: string, session = 'alpha', extra: readonly string[] = [], options: Parameters<CliHarness['run']>[1] = {}): Promise<void> {
  ok(await kit.run(['add', '--title', title, '--description', 'what and why', '--priority', 'p2', '--session', session, ...extra], options));
}

function rowsOf(lines: readonly string[]): readonly SweepRow[] {
  const parsed = parseSweepFile(lines.join('\n'));
  assert.ok(parsed.ok, 'the sweep rows parse');
  return parsed.value;
}

/** A row a person confirmed: team app's T1 unless `row` says otherwise. */
function confirmedRow(row: Partial<SweepRow> = {}): SweepRow {
  return { id: 'T1', team: 'app', owner: 'alpha', title: 'A task', class: 'Roadmap', objective: null, size: null, reason: 'a person read it', confidence: 'high', park: false, confirm: 'yes', ...row };
}

async function writeRows(kit: CliHarness, ...rows: readonly SweepRow[]): Promise<void> {
  await kit.files.write(FILE, formatSweepRows(rows));
}

/** The update events of a team's register, oldest first. */
function updatesOf(kit: CliHarness, events = EVENTS_PATH) {
  return readEvents(kit.files.get(events) ?? '').events.flatMap((event) => (event.type === 'update' ? [event] : []));
}

describe('teamrig sweep', () => {
  it('prints one row per active task on stdout and the counts on stderr, leaving a finished task out', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Polish the settings page');
    await addTask(kit, 'Lost data after a restore', 'bravo');
    await addTask(kit, 'Shipped already');
    ok(await kit.run(['set', 'T3', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'alpha']));
    const before = kit.files.get(EVENTS_PATH);

    const swept = await kit.run(['sweep']);

    ok(swept);
    assert.deepEqual(
      rowsOf(swept.stdout).map((row) => [row.id, row.team, row.owner, row.title, row.class, row.objective, row.confidence, row.park, row.confirm]),
      [
        ['T1', 'app', 'alpha', 'Polish the settings page', 'Improvements', null, 'medium', false, ''],
        ['T2', 'app', 'bravo', 'Lost data after a restore', 'Maintenance', null, 'medium', false, ''],
      ],
    );
    assert.deepEqual(swept.stderr, ['app: Improvements 1, Maintenance 1']);
    assert.equal(kit.files.get(EVENTS_PATH), before);
  });

  it("narrows to a session's own tasks with --session", async () => {
    const kit = new CliHarness();
    await addTask(kit, 'One of alpha');
    await addTask(kit, 'One of bravo', 'bravo');
    const swept = await kit.run(['sweep', '--session', 'bravo']);
    assert.deepEqual(rowsOf(swept.stdout).map((row) => row.id), ['T2']);
  });

  it('sizes a row from the task, then the default, and marks no row to park before a class is stored', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Sized by a person', 'alpha', ['--size', '2.5']);
    await addTask(kit, 'Sized by nobody');
    const swept = await kit.run(['sweep']);
    assert.deepEqual(rowsOf(swept.stdout).map((row) => [row.size, row.park]), [[2.5, false], [0.3, false]]);
  });

  it('keeps a stored class as the row says, whatever the rules would say', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Restore the backup', 'alpha', ['--class', 'Improvements']);
    const swept = await kit.run(['sweep']);
    assert.deepEqual(rowsOf(swept.stdout).map((row) => [row.class, row.reason, row.confidence]), [['Improvements', 'class already set', 'high']]);
  });

  it('writes the rows to --out, in a file apply reads, and the counts to stdout', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Polish the settings page');
    const swept = await kit.run(['sweep', '--out', 'sweep.jsonl']);
    ok(swept);
    assert.deepEqual(swept.stdout, ['app: Improvements 1', `WROTE 1 row(s) to ${FILE}: set confirm to yes on the rows you agree with, then teamrig sweep apply`]);
    assert.deepEqual(rowsOf([kit.files.get(FILE) ?? '']).map((row) => row.id), ['T1']);

    const dry = await kit.run(['sweep', 'apply', FILE, '--session', 'alpha']);
    assert.deepEqual([dry.code, dry.stdout], [EXIT.ok, ['dry run: inserted 0, changed 0, unchanged 0, unconfirmed 1; nothing was written: rerun with --apply to write']]);
  });

  it("rolls up every team's rows for the lead with --tree, and refuses a session that leads no team", async () => {
    const kit = await treeHarness();
    await addTask(kit, 'One of the root', 'lead');
    await addTask(kit, 'One of web', 'lead', [], WEB);
    const swept = await kit.run(['sweep', '--tree', '--session', 'lead']);
    ok(swept);
    assert.deepEqual(rowsOf(swept.stdout).map((row) => `${row.team}/${row.id}`).sort(), ['app/T1', 'web/T2']);
    assert.deepEqual([...swept.stderr].sort(), ['app: Improvements 1', 'web: Improvements 1']);

    const refused = await kit.run(['sweep', '--tree', '--session', 'alpha']);
    assert.equal(refused.code, EXIT.refused);
    assert.match(refused.stdout.join('\n'), /--tree is for the team's lead/);
  });

  it('proposes the roadmap class for a task serving a ranked goal, itself and through a key result', async () => {
    const kit = new CliHarness();
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Open the shop', '--target', '2030-02-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'add', 'K1', '--title', 'First sale', '--target', '2030-02-01', '--parent', 'A1', '--session', 'lead']));
    ok(await kit.run(['goal', 'rank', 'A1', '1', '--session', 'lead']));
    await addTask(kit, 'Serves the goal', 'alpha', ['--goals', 'A1']);
    await addTask(kit, 'Serves its key result', 'alpha', ['--goals', 'K1']);
    const swept = await kit.run(['sweep']);
    assert.deepEqual(rowsOf(swept.stdout).map((row) => [row.class, row.objective, row.confidence]), [['Roadmap', 'A1', 'high'], ['Roadmap', 'A1', 'high']]);
  });

  it('reads a title match with a ranked goal as a low-confidence roadmap row, and an unranked goal as none', async () => {
    const kit = new CliHarness();
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Checkout redesign live', '--target', '2030-02-01', '--session', 'lead']));
    await addTask(kit, 'Polish the checkout redesign');
    const unranked = await kit.run(['sweep']);
    assert.deepEqual(rowsOf(unranked.stdout).map((row) => [row.class, row.objective]), [['Improvements', null]]);

    ok(await kit.run(['goal', 'rank', 'A1', '1', '--session', 'lead']));
    const ranked = await kit.run(['sweep']);
    assert.deepEqual(rowsOf(ranked.stdout).map((row) => [row.class, row.objective, row.confidence]), [['Roadmap', 'A1', 'low']]);
  });

  it('reads the goals under register.goals free, which only leaves a task unchecked', async () => {
    const kit = new CliHarness();
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'Open the shop', '--target', '2030-02-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'rank', 'A1', '1', '--session', 'lead']));
    // Z9 holds no record, which only free takes: under checked this add would refuse.
    await addTask(kit, 'Serves the goal', 'alpha', ['--goals', 'A1,Z9']);
    const swept = await kit.run(['sweep']);
    assert.deepEqual(rowsOf(swept.stdout).map((row) => [row.class, row.objective]), [['Roadmap', 'A1']]);
  });

  it('serves a goal the team above ranked, as its goals reach this team', async () => {
    const kit = await treeHarness();
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'A goal above', '--target', '2030-02-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'rank', 'A1', '2', '--session', 'lead']));
    await addTask(kit, 'One of web', 'lead', ['--goals', 'A1'], WEB);
    const swept = await kit.run(['sweep', '--session', 'lead'], WEB);
    assert.deepEqual(rowsOf(swept.stdout).map((row) => [row.team, row.class, row.objective, row.reason]), [['web', 'Roadmap', 'A1', 'serves ranked goal A1 (#2)']]);
  });
});

describe('teamrig sweep apply', () => {
  it('names what a confirmed row would change and writes nothing, then writes it with --apply and reads as unchanged after', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Polish the settings page');
    await writeRows(kit, confirmedRow({ objective: 'K1', size: 1.5 }));
    const before = kit.files.get(EVENTS_PATH);

    const dry = await kit.run(['sweep', 'apply', FILE, '--session', 'alpha']);
    assert.deepEqual([dry.code, dry.stdout], [
      EXIT.ok,
      ['WOULD CHANGE app/T1: class Roadmap, goals K1, size 1.5', 'dry run: inserted 0, changed 1, unchanged 0; nothing was written: rerun with --apply to write'],
    ]);
    assert.equal(kit.files.get(EVENTS_PATH), before);

    const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']);
    assert.deepEqual([applied.code, applied.stdout], [EXIT.ok, ['CHANGED app/T1: class Roadmap, goals K1, size 1.5', 'inserted 0, changed 1, unchanged 0']]);
    const [update] = updatesOf(kit);
    assert.deepEqual([update?.by, update?.changes], ['alpha', { workClass: 'Roadmap', goals: ['K1'], size: 1.5 }]);
    assert.deepEqual(update?.sizeBase, { day: '2030-01-08', w: 0 });

    const again = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']);
    assert.deepEqual([again.code, again.stdout], [EXIT.ok, ['inserted 0, changed 0, unchanged 1']]);
    assert.equal(updatesOf(kit).length, 1);
  });

  it('carries no size base on a row that changes no size', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Polish the settings page');
    await writeRows(kit, confirmedRow());
    ok(await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']));
    assert.equal(updatesOf(kit)[0]?.sizeBase, undefined);
  });

  it('leaves a row nobody confirmed, whatever else its confirm says', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Polish the settings page');
    await addTask(kit, 'Polish the login page');
    await writeRows(kit, confirmedRow({ confirm: '' }), confirmedRow({ id: 'T2', confirm: 'maybe' }));
    const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']);
    assert.deepEqual([applied.code, applied.stdout], [EXIT.ok, ['inserted 0, changed 0, unchanged 0, unconfirmed 2']]);
    assert.deepEqual(updatesOf(kit), []);
  });

  it("refuses a row the caller may not write and lands the others, exiting refused only after --apply", async () => {
    const kit = new CliHarness();
    await addTask(kit, 'One of alpha');
    await addTask(kit, 'One of bravo', 'bravo');
    await writeRows(kit, confirmedRow(), confirmedRow({ id: 'T2', owner: 'bravo' }));

    const dry = await kit.run(['sweep', 'apply', FILE, '--session', 'bravo']);
    assert.equal(dry.code, EXIT.ok);
    assert.match(dry.stdout[0] ?? '', /^REFUSED app\/T1: /);
    assert.equal(dry.stdout[1], 'WOULD CHANGE app/T2: class Roadmap');

    const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'bravo']);
    assert.equal(applied.code, EXIT.refused);
    assert.equal(applied.stdout.at(-1), 'inserted 0, changed 1, unchanged 0, refused 1');
    assert.deepEqual(updatesOf(kit).map((event) => event.id), ['T2']);
  });

  it('refuses a confirmed row whose task is missing or finished', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Shipped already');
    ok(await kit.run(['set', 'T1', '--status', 'done', '--note', 'shipped', '--evidence', 'abc1234', '--skill', 'none', '--followups', 'none', '--session', 'alpha']));
    await writeRows(kit, confirmedRow(), confirmedRow({ id: 'T9' }));
    const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']);
    assert.deepEqual([applied.code, applied.stdout], [
      EXIT.refused,
      ['REFUSED app/T1: T1 is done now', 'REFUSED app/T9: no task T9 in team app', 'inserted 0, changed 0, unchanged 0, refused 2'],
    ]);
  });

  it('refuses a missing file, and a damaged one whole', async () => {
    const kit = new CliHarness();
    await addTask(kit, 'Polish the settings page');
    const missing = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']);
    assert.deepEqual([missing.code, missing.stdout], [EXIT.refused, [`REFUSED no sweep file ${FILE}`]]);

    await kit.files.write(FILE, `${formatSweepRows([confirmedRow()])}not a row\n`);
    const damaged = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']);
    assert.equal(damaged.code, EXIT.refused);
    assert.match(damaged.stdout[0] ?? '', /line 2 is not JSON/);
    assert.deepEqual(updatesOf(kit), []);
  });

  it("refuses a goal no record holds under checked goals, and takes one of a team above", async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('web'), formatConfig({ ...SUB_TEAMS['web'], register: { goals: 'checked' } }));
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'A goal above', '--target', '2030-02-01', '--session', 'lead']));
    await addTask(kit, 'One of web', 'lead', [], WEB);
    await addTask(kit, 'One more of web', 'lead', [], WEB);
    await writeRows(kit, confirmedRow({ team: 'web', owner: 'lead', objective: 'Z9' }), confirmedRow({ id: 'T2', team: 'web', owner: 'lead', objective: 'A1' }));
    const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead'], WEB);
    assert.equal(applied.code, EXIT.refused);
    assert.match(applied.stdout[0] ?? '', /^REFUSED web\/T1: goal Z9 is not a goal record/);
    assert.equal(applied.stdout[1], 'CHANGED web/T2: class Roadmap, goals A1');
  });

  it('adds no tag for a goal the task already serves through a key result, the chain read from the team above', async () => {
    const kit = await treeHarness();
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'A goal above', '--target', '2030-02-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'add', 'K1', '--title', 'A key result', '--target', '2030-02-01', '--parent', 'A1', '--session', 'lead']));
    await addTask(kit, 'One of web', 'lead', ['--goals', 'K1'], WEB);
    await writeRows(kit, confirmedRow({ team: 'web', owner: 'lead', objective: 'A1' }));
    const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead'], WEB);
    assert.deepEqual([applied.code, applied.stdout[0]], [EXIT.ok, 'CHANGED web/T1: class Roadmap']);
  });

  it("reads a tag two teams hold as the nearest team's", async () => {
    const kit = await treeHarness();
    ok(await kit.run(['goal', 'add', 'A1', '--title', 'The root goal', '--target', '2030-02-01', '--session', 'lead']));
    ok(await kit.run(['goal', 'add', 'B1', '--title', 'The web goal', '--target', '2030-02-01', '--session', 'lead'], WEB));
    ok(await kit.run(['goal', 'add', 'K1', '--title', 'Root key result', '--target', '2030-02-01', '--parent', 'A1', '--session', 'lead']));
    ok(await kit.run(['goal', 'add', 'K1', '--title', 'Web key result', '--target', '2030-02-01', '--parent', 'B1', '--session', 'lead'], WEB));
    await addTask(kit, 'One of web', 'lead', ['--goals', 'K1'], WEB);
    await writeRows(kit, confirmedRow({ team: 'web', owner: 'lead', objective: 'B1' }));
    const nearest = await kit.run(['sweep', 'apply', FILE, '--session', 'lead'], WEB);
    assert.equal(nearest.stdout[0], 'WOULD CHANGE web/T1: class Roadmap');
    await writeRows(kit, confirmedRow({ team: 'web', owner: 'lead', objective: 'A1' }));
    const above = await kit.run(['sweep', 'apply', FILE, '--session', 'lead'], WEB);
    assert.equal(above.stdout[0], 'WOULD CHANGE web/T1: class Roadmap, goals K1,A1');
  });

  describe('across teams', () => {
    /** The tree with one task in team web, T1, and one in team app, T2 (ids are one numbering across a tree). */
    async function twoTeams(): Promise<CliHarness> {
      const kit = await treeHarness();
      await addTask(kit, 'One of web', 'lead', [], WEB);
      await addTask(kit, 'One of the root', 'lead');
      return kit;
    }

    const WEB_ROW = confirmedRow({ team: 'web', owner: 'lead' });
    const ROOT_ROW = confirmedRow({ id: 'T2', owner: 'lead' });

    it("lets the lead of a team above write a row of a team below, the event by its address", async () => {
      const kit = await twoTeams();
      await writeRows(kit, WEB_ROW);
      const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead']);
      assert.deepEqual([applied.code, applied.stdout], [EXIT.ok, ['CHANGED web/T1: class Roadmap', 'inserted 0, changed 1, unchanged 0']]);
      assert.deepEqual(updatesOf(kit, teamEventsOf('web')).map((event) => [event.by, event.changes]), [['app/lead', { workClass: 'Roadmap' }]]);
    });

    it('refuses a child team lead a row of the team above, and a sibling team its row', async () => {
      const kit = await twoTeams();
      await writeRows(kit, ROOT_ROW);
      const up = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead'], WEB);
      assert.deepEqual([up.code, up.stdout[0]], [EXIT.refused, "REFUSED app/T2: only app's own sessions or the lead of a team above it apply this row"]);

      await writeRows(kit, WEB_ROW);
      const sideways = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead'], OPS);
      assert.deepEqual([sideways.code, sideways.stdout[0]], [EXIT.refused, "REFUSED web/T1: only web's own sessions or the lead of a team above it apply this row"]);
      assert.deepEqual(updatesOf(kit, teamEventsOf('web')), []);
    });

    it('refuses a session of a team above that leads nothing', async () => {
      const kit = await twoTeams();
      await writeRows(kit, WEB_ROW);
      const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'alpha']);
      assert.deepEqual([applied.code, applied.stdout[0]], [EXIT.refused, "REFUSED web/T1: only web's own sessions or the lead of a team above it apply this row"]);
    });

    it('lets the lead two teams above write, and keeps an unconfirmed row of a closed team unconfirmed', async () => {
      const kit = await treeHarness();
      await addTask(kit, 'One of ui', 'lead', [], UI);
      await writeRows(kit, confirmedRow({ team: 'ui', owner: 'lead' }));
      ok(await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead']));
      assert.deepEqual(updatesOf(kit, teamEventsOf('ui')).map((event) => event.by), ['app/lead']);

      await writeRows(kit, confirmedRow({ team: 'ui', owner: 'lead', confirm: '' }));
      const closed = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead'], OPS);
      assert.deepEqual([closed.code, closed.stdout], [EXIT.ok, ['inserted 0, changed 0, unchanged 0, unconfirmed 1']]);
    });

    it('refuses a row of a team with no config', async () => {
      const kit = await twoTeams();
      await writeRows(kit, confirmedRow({ team: 'nowhere', owner: 'lead' }));
      const applied = await kit.run(['sweep', 'apply', FILE, '--apply', '--session', 'lead']);
      assert.deepEqual([applied.code, applied.stdout[0]], [EXIT.refused, 'REFUSED nowhere/T1: no team nowhere with a config in this kit home']);
    });
  });
});
