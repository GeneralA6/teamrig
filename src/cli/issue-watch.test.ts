import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import type { Sleep } from '../core/lock.ts';
import { formatWatchLease, parseWatchLease } from '../github/watch.ts';
import { SessionRecordStore } from '../sessions/record.ts';
import { APP, CLAUDE_SESSION, CLI_PID, CliHarness, CONFIG_PATH, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeGh, ghIssue } from '../testing/fake-gh.ts';
import { FakeProcesses } from '../testing/fake-processes.ts';
import { EXIT } from './runtime.ts';

const WATCH_TEAM: JsonRecord = { ...TEAM, github: { repos: ['acme/web', 'acme/api'], owners: { octocat: 'bravo' } } };
const LEASE = join(TEAM_HOME, 'state', 'github-watch.json');
const MINUTE = 60_000;
const CLAUDE_PID = 6100;
const OTHER_WATCH_PID = 6200;
const STOP = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, stop_hook_active: false });
const START = JSON.stringify({ session_id: CLAUDE_SESSION, cwd: APP, source: 'startup' });
const WATCH_START = { command: '/usr/bin/node', args: ['/opt/teamrig/dist/cli/main.js', 'issue', 'watch'], cwd: TEAM_HOME, team: 'app' };

/** A turn's end in `session`'s tab; the hook must print nothing and end well. */
async function stop(kit: CliHarness, processes: FakeProcesses, session = 'lead', env: Readonly<Record<string, string>> = {}): Promise<void> {
  const result = await kit.run(['hook', 'stop'], { stdin: STOP, env: { TEAMRIG_SESSION: session, ...env }, processes });
  assert.equal(result.code, EXIT.ok);
  assert.deepEqual(result.stdout, []);
}

function started(processes: FakeProcesses): JsonRecord[] {
  return processes.hidden.map((request) => ({ command: request.command, args: request.args, cwd: request.cwd, team: request.env['TEAMRIG_TEAM'] }));
}

/** The lead's Claude Code tab runs, as its SessionStart hook recorded it. */
async function leadRuns(kit: CliHarness): Promise<void> {
  kit.sessionProcesses.add({ pid: CLAUDE_PID, parentPid: 1, name: 'claude.exe', commandLine: 'claude' });
  await new SessionRecordStore(kit.files, { sessions: join(TEAM_HOME, 'state', 'sessions') }).write('lead', {
    claudePid: CLAUDE_PID,
    claudeSession: CLAUDE_SESSION,
    at: '2030-01-08T07:00:00.000Z',
  });
}

/** A sleep that moves the clock and then takes the next step of the world, one per wait. */
function scripted(kit: CliHarness, steps: (() => unknown)[]): Sleep {
  return async (ms) => {
    await kit.clock.sleep(ms);
    await steps.shift()?.();
  };
}

describe('the hooks start the GitHub watch', () => {
  it('Stop starts issue watch hidden, for its team, once while its lease holds, and again once the lease lapsed', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    const processes = new FakeProcesses();
    await stop(kit, processes);
    await stop(kit, processes, 'alpha');
    assert.deepEqual(started(processes), [WATCH_START]);
    assert.deepEqual(parseWatchLease(kit.files.get(LEASE) ?? ''), { pid: undefined, startedAt: kit.clock.now(), beatAt: kit.clock.now() });

    // The started watch never beat: three probe intervals and the grace later, the next hook starts another.
    kit.clock.advance(5 * MINUTE);
    await stop(kit, processes, 'alpha');
    assert.equal(processes.hidden.length, 1);
    kit.clock.advance(1);
    await stop(kit, processes, 'alpha');
    assert.equal(processes.hidden.length, 2);
  });

  it('SessionStart starts it too, so a team whose sessions all stopped gets its watch back before a turn ends', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    const processes = new FakeProcesses();
    const result = await kit.run(['hook', 'session-start'], { stdin: START, env: { TEAMRIG_SESSION: 'lead' }, processes });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.deepEqual(started(processes), [WATCH_START]);
  });

  it('leaves a running watch alone, and replaces one whose process ended though its beat is fresh', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    const processes = new FakeProcesses();
    const now = kit.clock.now();
    await kit.files.write(LEASE, formatWatchLease({ pid: OTHER_WATCH_PID, startedAt: now - 30 * MINUTE, beatAt: now - MINUTE }));
    kit.sessionProcesses.add({ pid: OTHER_WATCH_PID, parentPid: 1, name: 'node', commandLine: 'node teamrig issue watch' });
    await stop(kit, processes);
    assert.deepEqual(processes.hidden, []);

    kit.sessionProcesses.exit(OTHER_WATCH_PID);
    await stop(kit, processes);
    assert.deepEqual(started(processes), [WATCH_START]);
  });

  it('starts nothing with probeSeconds 0, no repository listed or TEAMRIG_GITHUB=off', async () => {
    for (const [config, env] of [
      [{ ...TEAM, github: { repos: ['acme/web'], probeSeconds: 0 } }, {}],
      [TEAM, {}],
      [WATCH_TEAM, { TEAMRIG_GITHUB: 'Off' }],
    ] as const) {
      const kit = new CliHarness(config);
      const processes = new FakeProcesses();
      await stop(kit, processes, 'lead', env);
      assert.deepEqual(processes.hidden, []);
      assert.equal(kit.files.get(LEASE), undefined);
    }
  });
});

describe('teamrig issue watch', () => {
  it('syncs when GitHub changed and only then, beats its lease, and stops once no session ran for 10 minutes', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    await leadRuns(kit);
    const gh = new FakeGh().holds('acme/web', [ghIssue('acme/web', 7, { title: 'Fix login', assignees: ['octocat'] })]).holds('acme/api', []);
    const leases: (number | undefined)[] = [];
    const sleep = scripted(kit, [
      () => leases.push(parseWatchLease(kit.files.get(LEASE) ?? '')?.pid),
      () => gh.changes('acme/api', 'actions/runs?per_page=5'),
      () => kit.sessionProcesses.exit(CLAUDE_PID),
    ]);
    const result = await kit.run(['issue', 'watch'], { gh, sleep });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));

    // Round 1 synced (nothing seen yet), round 2 found nothing new, round 3 the Actions run; the idle rounds none.
    assert.equal(result.stdout.filter((line) => line.startsWith('WROTE ')).length, 2, result.stdout.join('\n'));
    assert.deepEqual(gh.probes().slice(0, 4), ['acme/web/issues?state=all&sort=updated&per_page=1', 'acme/web/actions/runs?per_page=5', 'acme/api/issues?state=all&sort=updated&per_page=1', 'acme/api/actions/runs?per_page=5']);
    assert.deepEqual(leases, [CLI_PID]);
    assert.ok(kit.clock.sleeps.every((ms) => ms === MINUTE), kit.clock.sleeps.join(' '));
    // The session ended after round 3; round 4 starts the idle time and round 14 ends it.
    assert.equal(kit.clock.sleeps.length, 13);
    assert.equal(result.stdout.at(-1), 'STOP no session of the team ran for 10 minutes; the next one starts the watch again');
    assert.equal(kit.files.get(LEASE), undefined);
  });

  it('after a failed sync, syncs a change again only once 15 minutes passed, keeping the change unseen', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    await leadRuns(kit);
    const refused = { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n' } as const;
    const gh = new FakeGh().holds('acme/web', []).holds('acme/api', []).answers('acme/api', refused);
    const steps: (() => void)[] = Array.from({ length: 16 }, () => () => undefined);
    steps.push(() => kit.sessionProcesses.exit(CLAUDE_PID));
    const result = await kit.run(['issue', 'watch'], { gh, sleep: scripted(kit, steps) });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    // The first sync failed at minute 0; the change it missed reads as one each round, synced again at minute 15 only.
    assert.equal(result.stdout.filter((line) => line.startsWith('WROTE ')).length, 2, result.stdout.join('\n'));
  });

  it('a failing probe syncs every 15 minutes, so a repository GitHub stopped answering is still read and reported', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    await leadRuns(kit);
    const gh = new FakeGh().holds('acme/web', []).holds('acme/api', []).failsProbe('acme/api', { end: { kind: 'exited', code: 1 }, stdout: '', stderr: 'gh: Bad credentials (HTTP 401)\n' });
    const steps: (() => void)[] = Array.from({ length: 16 }, () => () => undefined);
    steps.push(() => kit.sessionProcesses.exit(CLAUDE_PID));
    const result = await kit.run(['issue', 'watch'], { gh, sleep: scripted(kit, steps) });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.equal(result.stdout.filter((line) => line.startsWith('WROTE ')).length, 2, result.stdout.join('\n'));
    assert.ok(result.stdout.includes('FAILED acme/api issues: gh api exited with code 1: gh: Bad credentials (HTTP 401)'), result.stdout.join('\n'));
  });

  it('stops at once when another live watch holds the lease, and takes over one whose process ended', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    const gh = new FakeGh().holds('acme/web', []).holds('acme/api', []);
    const now = kit.clock.now();
    const other = formatWatchLease({ pid: OTHER_WATCH_PID, startedAt: now - 30 * MINUTE, beatAt: now - MINUTE });
    await kit.files.write(LEASE, other);
    kit.sessionProcesses.add({ pid: OTHER_WATCH_PID, parentPid: 1, name: 'node', commandLine: 'node teamrig issue watch' });
    const held = await kit.run(['issue', 'watch'], { gh });
    assert.deepEqual(held.stdout, ['HELD another watch runs for this team; this one stops']);
    assert.deepEqual(gh.probes(), []);
    assert.equal(kit.files.get(LEASE), other);

    kit.sessionProcesses.exit(OTHER_WATCH_PID);
    const took = await kit.run(['issue', 'watch'], { gh });
    assert.equal(took.code, EXIT.ok, took.stderr.join('\n'));
    assert.equal(took.stdout.at(-1), 'STOP no session of the team ran for 10 minutes; the next one starts the watch again');
    assert.ok(gh.probes().length > 0);
  });

  it('stops when another watch took its lease, leaving that lease in place', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    await leadRuns(kit);
    const gh = new FakeGh().holds('acme/web', []).holds('acme/api', []);
    const taken = formatWatchLease({ pid: OTHER_WATCH_PID, startedAt: kit.clock.now(), beatAt: kit.clock.now() });
    const result = await kit.run(['issue', 'watch'], { gh, sleep: scripted(kit, [() => kit.files.write(LEASE, taken)]) });
    assert.equal(result.stdout.at(-1), 'STOP another watch holds the lease');
    assert.equal(kit.files.get(LEASE), taken);
  });

  it('runs no watch when GitHub is off for the team or the machine', async () => {
    for (const [config, env, reason] of [
      [{ ...TEAM, github: { repos: ['acme/web'], probeSeconds: 0 } }, {}, 'github.probeSeconds is 0: the sync runs only with issue sync --yes'],
      [TEAM, {}, 'no repository is listed under github.repos'],
      [WATCH_TEAM, { TEAMRIG_GITHUB: 'off' }, 'TEAMRIG_GITHUB=off turns the GitHub import off on this machine'],
    ] as const) {
      const kit = new CliHarness(config);
      const result = await kit.run(['issue', 'watch'], { env });
      assert.deepEqual(result.stdout, [`OFF ${reason}; no watch runs`]);
      assert.equal(kit.files.get(LEASE), undefined);
    }
  });

  it('a config edit to probeSeconds 0 stops a running watch at its next round', async () => {
    const kit = new CliHarness(WATCH_TEAM);
    await leadRuns(kit);
    const gh = new FakeGh().holds('acme/web', []).holds('acme/api', []);
    const off = (): Promise<void> => kit.files.write(CONFIG_PATH, JSON.stringify({ ...WATCH_TEAM, github: { repos: ['acme/web'], probeSeconds: 0 } }));
    const result = await kit.run(['issue', 'watch'], { gh, sleep: scripted(kit, [off]) });
    assert.equal(result.stdout.at(-1), 'STOP github.probeSeconds is 0: the sync runs only with issue sync --yes');
    assert.equal(kit.files.get(LEASE), undefined);
  });
});
