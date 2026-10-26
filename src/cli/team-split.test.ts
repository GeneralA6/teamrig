import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, CONFIG_PATH, KIT, type CliResult } from '../testing/cli-harness.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { EXIT } from './runtime.ts';

/** Team `app`: `carol` reviews security; the split moves `alpha`, leading, and `bravo` into `web`. */
const TEAM = { sessions: ['lead', 'alpha', 'bravo', 'carol'], roles: { lead: 'lead', securityReviewer: 'carol' } };
const SPLIT = ['team', 'split', 'web', '--lead', 'alpha', '--sessions', 'bravo', '--dry-run'];

function split(kit: CliHarness, argv: readonly string[] = SPLIT, session = 'lead'): Promise<CliResult> {
  return kit.run([...argv, '--session', session], { probe: new MemoryPathProbe(kit.files) });
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
      'DRY RUN nothing is written; team split only plans for now',
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

  it('writes nothing', async () => {
    const kit = await withTask();
    const before = new Map(kit.files.paths().map((path) => [path, kit.files.get(path)]));
    assert.equal((await split(kit)).code, EXIT.ok);
    assert.deepEqual(new Map(kit.files.paths().map((path) => [path, kit.files.get(path)])), before);
  });

  it('refuses without --dry-run, as it only plans for now', async () => {
    assert.equal(refusal(await split(new CliHarness(TEAM), SPLIT.slice(0, -1))), 'REFUSED team split only plans for now: run it with --dry-run to see what it would move');
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
