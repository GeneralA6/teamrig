import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { parseObject } from '../core/jsonl.ts';
import { readRegister } from '../register/snapshot.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { CLAUDE_SESSION, CliHarness, CONFIG_PATH, EVENTS_PATH, KIT, RENAMES_PATH, TEAM_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { configChangedMeanwhile, hired } from '../testing/config-race.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { EXIT } from './runtime.ts';

/** Team `app`: `carol` reviews security; the split moves `alpha`, leading, and `bravo` into `web`. */
const TEAM = { sessions: ['lead', 'alpha', 'bravo', 'carol'], roles: { lead: 'lead', securityReviewer: 'carol' } };
const SPLIT = ['team', 'split', 'web', '--lead', 'alpha', '--sessions', 'bravo', '--dry-run'];
const WRITE = SPLIT.slice(0, -1);
const WEB = join(KIT, 'teams', 'web');

function split(kit: CliHarness, argv: readonly string[] = SPLIT, session = 'lead', options: RunOptions = {}): Promise<CliResult> {
  return kit.run([...argv, '--session', session], { probe: new MemoryPathProbe(kit.files), ...options });
}

/** Every file of the harness with its text, to show a refused split wrote nothing. */
function filesOf(kit: CliHarness): Map<string, string | undefined> {
  return new Map(kit.files.paths().map((path) => [path, kit.files.get(path)]));
}

/** The sessions a config file lists. */
async function sessionsIn(kit: CliHarness, path: string): Promise<unknown> {
  return parseObject((await kit.files.read(path)) ?? '')?.['sessions'];
}

function refusal(result: CliResult): string {
  assert.equal(result.code, EXIT.refused, [...result.stdout, ...result.stderr].join('\n'));
  return result.stdout.join('\n');
}

/** The harness with T1 asked by the lead of alpha, which gives alpha an inbox line. */
async function withTask(): Promise<CliHarness> {
  const kit = new CliHarness(TEAM);
  await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']);
  return kit;
}

describe('team split', () => {
  it("prints the plan: the child's config, what the parent loses, the tasks that move and what crosses", async () => {
    const kit = await withTask();
    const result = await split(kit);
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    const { stdout } = result;
    assert.deepEqual(stdout.slice(0, 4), [
      'DRY RUN nothing is written',
      'TEAM web under app: lead alpha (app-alpha); sessions alpha (app-alpha), bravo (app-bravo)',
      `WOULD CREATE ${join(KIT, 'teams', 'web', 'config.json')}:`,
      '{',
    ]);
    assert.ok(stdout.includes('    "securityReviewer": "app/carol"'), stdout.join('\n'));
    for (const line of [
      `PARENT ${CONFIG_PATH} loses sessions alpha, bravo`,
      'TASKS 1 move to web, 0 stay in app',
      '  alpha: 1 open',
      'REWRITE T1 source lead -> app/lead',
      'INBOX alpha: 1 line(s) move',
    ]) {
      assert.ok(stdout.includes(line), `${line}\n---\n${stdout.join('\n')}`);
    }
    const files = stdout.find((line) => line.startsWith('FILES alpha: '));
    assert.ok(files?.includes(join('state', 'inbox', 'alpha.md')), stdout.join('\n'));
  });

  it('prints the sub-lead lists, the links and the renames that cross the new border', async () => {
    const kit = new CliHarness({ ...TEAM, roles: { lead: 'lead' }, sessions: [...TEAM.sessions, 'dave'], leads: { alpha: ['dave'], carol: ['bravo'] } });
    await kit.run(['add', '--title', 'Ship the CLI', '--description', 'what and why', '--priority', 'p1', '--owner', 'alpha', '--session', 'lead']);
    await kit.run(['add', '--title', 'Use the CLI', '--description', 'what and why', '--priority', 'p1', '--owner', 'carol', '--after', 'T1', '--session', 'lead']);
    await kit.run(['rename', 'bravo', 'bee', '--session', 'lead']);
    const result = await split(kit);
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    for (const line of [
      `PARENT ${CONFIG_PATH} loses sessions alpha, bravo and keys leads.alpha`,
      "SUB-LEAD carol's list loses bravo, which moves",
      'UNLED dave: its sub-lead alpha moves, so the lead leads it',
      'LINK T2 in app runs after T1 in web',
      'RENAMES bravo: 1 rename line(s) move',
    ]) {
      assert.ok(result.stdout.includes(line), `${line}\n---\n${result.stdout.join('\n')}`);
    }
  });

  it("prints what blocks the split: a staying task's wait on the approval of its sub-lead, which moves", async () => {
    const kit = new CliHarness({ ...TEAM, leads: { alpha: ['carol'] } });
    await kit.run(['add', '--title', 'Merge the CLI', '--description', 'what and why', '--priority', 'p1', '--owner', 'carol', '--session', 'lead']);
    await kit.run(['set', 'T1', '--status', 'in-progress', '--session', 'carol']);
    const waits = await kit.run(['set', 'T1', '--status', 'waiting', '--waits', 'approval:alpha', '--note', 'asks alpha', '--session', 'carol']);
    assert.equal(waits.code, EXIT.ok, [...waits.stdout, ...waits.stderr].join('\n'));
    const result = await split(kit);
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    const blocked = "T1 waits on alpha's approval, and alpha moves: ask it of a session that stays, then split";
    assert.ok(result.stdout.includes(`BLOCKED ${blocked}`), result.stdout.join('\n'));
    const before = filesOf(kit);
    assert.equal(refusal(await split(kit, WRITE)), `REFUSED ${blocked}`);
    assert.deepEqual(filesOf(kit), before);
  });

  it("refuses while a moved session's Claude Code runs, which the dry run names", async () => {
    const kit = await withTask();
    const record = { claudePid: 8100, claudeSession: CLAUDE_SESSION, at: '2030-01-08T08:00:00.000Z' };
    await new SessionRecordStore(kit.files, { sessions: join(TEAM_HOME, 'state', 'sessions') }).write('bravo', record);
    const sessionProcesses = new FakeSessionProcesses().add({ pid: 8100, parentPid: 8000, name: 'claude.exe', commandLine: 'claude' });
    const blocked = "bravo's Claude Code runs (pid 8100): close its tab, then split";
    const plan = await split(kit, SPLIT, 'lead', { sessionProcesses });
    assert.ok(plan.stdout.includes(`BLOCKED ${blocked}`), plan.stdout.join('\n'));
    const before = filesOf(kit);
    assert.equal(refusal(await split(kit, WRITE, 'lead', { sessionProcesses })), `REFUSED ${blocked}`);
    assert.deepEqual(filesOf(kit), before);
    sessionProcesses.exit(8100);
    assert.equal((await split(kit, WRITE, 'lead', { sessionProcesses })).code, EXIT.ok);
  });

  it("names the keys of the parent's config the child starts without, and prints no such line when there are none", async () => {
    const result = await split(new CliHarness({ ...TEAM, github: { repos: ['org/app'] } }));
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.ok(result.stdout.includes('LEFT OUT github: the child starts without them'), result.stdout.join('\n'));
    assert.ok(!(await split(new CliHarness(TEAM))).stdout.some((line) => line.startsWith('LEFT OUT')));
  });

  it('writes nothing with --dry-run', async () => {
    const kit = await withTask();
    const before = filesOf(kit);
    assert.equal((await split(kit)).code, EXIT.ok);
    assert.deepEqual(filesOf(kit), before);
  });

  it("writes the split: the moved tasks' register, the moved sessions' files and renames, the child's config and the parent's trimmed", async () => {
    const kit = await withTask();
    await kit.run(['add', '--title', 'Keep the API', '--description', 'what and why', '--priority', 'p2', '--owner', 'carol', '--session', 'lead']);
    await kit.run(['rename', 'bravo', 'bee', '--session', 'lead']);
    const result = await split(kit, WRITE);
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(result.stdout.map((line) => line.split(' ')[0]), ['MOVED', 'FILES', 'FILES', 'RENAMES', 'CREATED', 'TRIMMED', 'VERIFIED', 'NEXT']);
    for (const line of [
      `MOVED 1 task(s) to ${join(WEB, 'state', 'events.jsonl')}; app's register sends each there`,
      'FILES bravo: none kept',
      'RENAMES 1 line(s) moved',
      `CREATED ${join(WEB, 'config.json')}`,
      `TRIMMED ${CONFIG_PATH}: sessions alpha, bravo left; the old config is at ${join(TEAM_HOME, 'backups', 'config.split.json')}`,
      'VERIFIED 1 task(s) read the same in web, and app sends each there',
      'NEXT reopen each moved session from its team: teamrig open web/alpha; teamrig open web/bravo',
    ]) {
      assert.ok(result.stdout.includes(line), `${line}\n---\n${result.stdout.join('\n')}`);
    }
    const files = result.stdout.find((line) => line.startsWith('FILES alpha: '));
    assert.ok(files?.includes(join('state', 'inbox', 'alpha.md')), result.stdout.join('\n'));
    const child = readRegister((await kit.files.read(join(WEB, 'state', 'events.jsonl'))) ?? '').state;
    assert.deepEqual([...child.tasks.keys()], ['T1']);
    assert.equal(child.tasks.get('T1')?.source, 'app/lead');
    const parent = readRegister((await kit.files.read(EVENTS_PATH)) ?? '').state;
    assert.deepEqual([...parent.tasks.keys()], ['T2']);
    assert.equal(parent.moved.get('T1'), 'web');
    assert.equal(kit.files.get(join(TEAM_HOME, 'state', 'inbox', 'alpha.md')), undefined);
    assert.notEqual(kit.files.get(join(WEB, 'state', 'inbox', 'alpha.md')), undefined);
    assert.equal(await kit.files.read(RENAMES_PATH), '');
    assert.match((await kit.files.read(join(WEB, 'state', 'renames.jsonl'))) ?? '', /"to":"bee"/);
    assert.deepEqual(await sessionsIn(kit, CONFIG_PATH), ['lead', 'carol']);
    assert.deepEqual(await sessionsIn(kit, join(WEB, 'config.json')), ['alpha', 'bravo']);
    assert.equal(kit.files.get(join(TEAM_HOME, 'backups', 'config.split.json')), formatConfig(TEAM));
  });

  it("trims the parent's config as it reads under the config lock, keeping a session hired meanwhile", async () => {
    const kit = await withTask();
    const sleep = await configChangedMeanwhile(kit, hired('dave'));
    const result = await split(kit, WRITE, 'lead', { sleep });
    assert.equal(result.code, EXIT.ok, [...result.stdout, ...result.stderr].join('\n'));
    assert.deepEqual(await sessionsIn(kit, CONFIG_PATH), ['lead', 'carol', 'dave']);
    assert.deepEqual(await sessionsIn(kit, join(WEB, 'config.json')), ['alpha', 'bravo']);
  });

  it('refuses a caller other than the lead', async () => {
    assert.equal(refusal(await split(new CliHarness(TEAM), SPLIT, 'alpha')), 'REFUSED only the lead (app-lead) splits the team');
  });

  it('refuses a child whose folder exists already', async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(join(KIT, 'teams', 'web', 'state', 'events.jsonl'), '');
    assert.equal(refusal(await split(kit)), `REFUSED ${join(KIT, 'teams', 'web')} exists already; a split makes a new team`);
  });

  it("refuses what the plan refuses, such as moving the holder of one of the team's roles", async () => {
    const argv = ['team', 'split', 'web', '--lead', 'alpha', '--sessions', 'carol', '--dry-run'];
    assert.equal(refusal(await split(new CliHarness(TEAM), argv)), "REFUSED carol is team app's securityReviewer; give that role to a session that stays, then split");
  });
});
