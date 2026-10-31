import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { encodePrompt } from '../open/prompt.ts';
import { shellCommand } from '../open/quote.ts';
import type { RestoreChoice } from '../restore/countdown.ts';
import type { RestoreEntry } from '../restore/entry.ts';
import { continuePrompt } from '../restore/plan.ts';
import { RestoreRegistry, restoreSessionsDir } from '../restore/registry.ts';
import { TAB_STAGGER_MS } from '../restore/run.ts';
import { APP, CliHarness, KIT, TEAM, USER_HOME, type CliResult, type RunOptions } from '../testing/cli-harness.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { FakeCountdown, FakeShutdownLog, FakeStopWatch } from '../testing/fake-restore.ts';
import { FakeSessionProcesses } from '../testing/fake-session-processes.ts';
import { MemoryPathProbe } from '../testing/memory-files.ts';
import { RESTORE_TAB_TITLE, restoreLogPath, TAB_CLOSE_DELAY_MS, TAB_SETTLE_MS } from './commands/restore.ts';
import { EXIT } from './runtime.ts';

const NODE = '/usr/bin/node';
const SCRIPT = '/opt/teamrig/dist/cli/main.js';
const HOME_ARGS = ['--home', resolve(APP, KIT)];
const SHUTDOWN = Date.parse('2030-01-08T09:50:00Z');
const ALPHA = '10000000-2222-4333-8444-555555555555';
const NOTES = '20000000-2222-4333-8444-555555555555';
const LIVE = '30000000-2222-4333-8444-555555555555';
const TRANSCRIPTS = join('/', 't');
const LIVE_PID = 9100;
const REUSED_PID = 9200;

const turn = (effort: string): string => JSON.stringify({ type: 'assistant', effort, message: { model: 'claude-opus-5-5' } });
const transcriptOf = (id: string): string => join(TRANSCRIPTS, `${id}.jsonl`);

function entry(claudeSession: string, createdAt: number, overrides: Partial<RestoreEntry> = {}): RestoreEntry {
  return {
    claudeSession,
    projectDir: APP,
    transcriptPath: transcriptOf(claudeSession),
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: undefined,
    team: undefined,
    session: undefined,
    state: 'ready',
    createdAt,
    updatedAt: SHUTDOWN - 60_000,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    ...overrides,
  };
}

/**
 * Team `app` with three sessions the shutdown met: alpha, which `launch` ran, idle at high effort; `notes`, outside
 * any team, mid-turn, whose pid the system gave another program since; and one whose Claude Code still runs.
 */
async function restoreKit(
  entries: readonly RestoreEntry[] = [entry(ALPHA, 1, { team: 'app', session: 'alpha' }), entry(NOTES, 2, { state: 'working', pid: REUSED_PID }), entry(LIVE, 3, { pid: LIVE_PID })],
  config: JsonRecord = TEAM,
): Promise<CliHarness> {
  const kit = new CliHarness(config);
  await kit.files.write(transcriptOf(ALPHA), `${turn('high')}\n`);
  await kit.files.write(transcriptOf(NOTES), `${JSON.stringify({ type: 'custom-title', customTitle: 'notes', sessionId: NOTES })}\n`);
  await kit.files.write(transcriptOf(LIVE), `${turn('low')}\n`);
  const registry = new RestoreRegistry(kit.files, restoreSessionsDir(KIT));
  for (const recorded of entries) {
    await registry.write(recorded);
  }
  return kit;
}

function machine(kit: CliHarness, processes: FakeProcesses, choice: RestoreChoice = 'go'): RunOptions & { readonly countdown: FakeCountdown } {
  const countdown = new FakeCountdown(choice);
  const sessionProcesses = new FakeSessionProcesses()
    .add({ pid: LIVE_PID, parentPid: 1, name: 'claude.exe', commandLine: 'claude' })
    .add({ pid: REUSED_PID, parentPid: 1, name: 'notepad.exe', commandLine: 'notepad.exe' });
  return { platform: 'win32', processes, probe: new MemoryPathProbe(kit.files), sessionProcesses, restore: { shutdowns: new FakeShutdownLog({ start: SHUTDOWN, end: SHUTDOWN + 60_000 }), countdown, stops: new FakeStopWatch(), logon: undefined, shortcuts: undefined }, countdown };
}

function windowsTab(title: string, folder: string, argv: readonly string[]): string[] {
  return ['-w', '0', 'new-tab', '--title', title, '-d', folder, '--', ...argv];
}

const ALPHA_LAUNCH = [NODE, SCRIPT, 'launch', 'alpha', '--team', 'app', '--project', APP, ...HOME_ARGS, '--resume', ALPHA, '--effort', 'high', '--no-prompt'];
const NOTES_RESUME = [NODE, SCRIPT, 'restore', 'resume', NOTES, '--project', APP, ...HOME_ARGS, '--encoded-prompt', encodePrompt(continuePrompt({ background: 0, crons: 0, wake: false }, undefined))];

async function logOf(kit: CliHarness): Promise<string> {
  return (await kit.files.read(restoreLogPath(KIT))) ?? '';
}

function okResult(result: CliResult): void {
  assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
}

describe('teamrig restore', () => {
  it('shows what a restore would do with each session, a reused pid not taken for Claude Code, and changes nothing', async () => {
    const kit = await restoreKit();
    const result = await kit.run(['restore'], machine(kit, new FakeProcesses()));
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        `RESTORE  ${ALPHA}  app-alpha  killed without exiting; idle; effort high  ${APP}`,
        `RESTORE  ${NOTES}  notes  killed without exiting; continue: mid-turn; effort default  ${APP}`,
        `KEEP     ${LIVE}  still running  ${APP}`,
      ],
      stderr: [],
    });
    assert.equal((await new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).list()).length, 3);
    assert.equal(await logOf(kit), '');
  });
});

describe('teamrig restore check', () => {
  const RUN = [NODE, SCRIPT, 'restore', 'run', '--since', '2030-01-08T10:00:00.000Z', '--tab', ...HOME_ARGS];

  it('opens a tab that runs the restore for the sessions the shutdown killed', async () => {
    const kit = await restoreKit();
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await kit.run(['restore', 'check'], machine(kit, processes));
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['OPENED the restore of 2 Claude Code sessions in a new Windows Terminal tab'], stderr: [] });
    assert.deepEqual(processes.started[0]?.args, windowsTab(RESTORE_TAB_TITLE, USER_HOME, RUN));
    assert.equal(await logOf(kit), [
      '2030-01-08T10:00:00.000Z check: started',
      '2030-01-08T10:00:00.000Z check: 2 to restore, 1 kept, 0 closed',
      '2030-01-08T10:00:00.000Z check: opened the restore tab; windows-terminal exited 0',
      '',
    ].join('\n'));
  });

  it('prints the command to run, and exits 3, when no terminal opens', async () => {
    const kit = await restoreKit();
    const result = await kit.run(['restore', 'check'], machine(kit, new FakeProcesses()));
    assert.equal(result.code, EXIT.printed);
    assert.deepEqual(result.stdout, ['MANUAL no terminal opened (windows-terminal is not installed); open a new terminal and run this in PowerShell:', shellCommand('win32', USER_HOME, RUN)]);
  });

  it('logs that it started before a bad flag stops it (T1705)', async () => {
    const kit = await restoreKit();
    const result = await kit.run(['restore', 'check', '--terminal', 'nope'], machine(kit, new FakeProcesses()));
    assert.equal(result.code, EXIT.usage);
    assert.equal(await logOf(kit), '2030-01-08T10:00:00.000Z check: started\n');
  });

  it('opens nothing when no session needs a restore', async () => {
    const kit = await restoreKit([entry(LIVE, 3, { pid: LIVE_PID })]);
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await kit.run(['restore', 'check'], machine(kit, processes));
    assert.deepEqual(result, { code: EXIT.ok, stdout: ['No Claude Code sessions to restore.'], stderr: [] });
    assert.deepEqual(processes.started, []);
  });
});

describe('teamrig restore run', () => {
  it('reopens a launched team session through launch and any other through restore resume, each at its last effort', async () => {
    const kit = await restoreKit();
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const options = machine(kit, processes);
    const result = await kit.run(['restore', 'run'], options);
    okResult(result);
    assert.deepEqual(options.countdown.counted, [60]);
    assert.deepEqual(
      processes.started.map((request) => request.args),
      [windowsTab('[app] alpha', APP, ALPHA_LAUNCH), windowsTab('notes', APP, NOTES_RESUME)],
    );
    assert.deepEqual(kit.clock.sleeps, [TAB_STAGGER_MS]);
    assert.ok(result.stdout.includes('Opened app-alpha (idle)'));
    assert.ok(result.stdout.includes('Opened notes (continue: mid-turn)'));
    assert.equal((await new RestoreRegistry(kit.files, restoreSessionsDir(KIT)).read(ALPHA))?.restoreAttempts, 1);
    assert.match(await logOf(kit), new RegExp(`run: opened ${ALPHA} \\(idle\\) at effort high; windows-terminal exited 0\n`));
    assert.doesNotMatch(await logOf(kit), /tab opened/, 'a run by hand is not in its tab');
  });

  it("reopens a team's session in the team's own Windows Terminal window when open.teamWindow is on, and one outside any team as before (T1427)", async () => {
    const kit = await restoreKit(undefined, { ...TEAM, open: { teamWindow: true } });
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    okResult(await kit.run(['restore', 'run'], machine(kit, processes)));
    assert.deepEqual(
      processes.started.map((request) => request.args.slice(0, 2)),
      [
        ['-w', 'teamrig-app'],
        ['-w', '0'],
      ],
    );
  });

  it('in its own tab, stays a moment once all are open and longer, exiting 1, when one did not open', async () => {
    const opened = await restoreKit();
    okResult(await opened.run(['restore', 'run', '--tab'], machine(opened, new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' }))));
    assert.deepEqual(opened.clock.sleeps, [TAB_STAGGER_MS, TAB_SETTLE_MS]);
    assert.match(await logOf(opened), /^\S+ run: tab opened\n\S+ run: started, 2 to reopen\n/);
    const failed = await restoreKit();
    const result = await failed.run(['restore', 'run', '--tab'], machine(failed, new FakeProcesses()));
    assert.equal(result.code, EXIT.failed);
    assert.ok(result.stdout.includes(`FAILED to reopen app-alpha: no terminal opened (windows-terminal is not installed); run: ${shellCommand('win32', APP, ALPHA_LAUNCH)}`));
    assert.equal(result.stdout.at(-1), `This tab closes in ${TAB_CLOSE_DELAY_MS / 1_000} s.`);
    assert.deepEqual(failed.clock.sleeps, [TAB_CLOSE_DELAY_MS]);
    assert.equal((await new RestoreRegistry(failed.files, restoreSessionsDir(KIT)).read(ALPHA))?.restoreAttempts, 0);
  });

  it('leaves alone the sessions active since --since, and refuses a --since that is not a time', async () => {
    const kit = await restoreKit();
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started', end: 'exited' });
    const result = await kit.run(['restore', 'run', '--since', '2030-01-08T09:00:00Z'], machine(kit, processes));
    assert.deepEqual(result.stdout, ['No Claude Code sessions to restore.']);
    assert.deepEqual(processes.started, []);
    assert.equal((await kit.run(['restore', 'run', '--since', 'soon'], machine(kit, processes))).code, EXIT.usage);
  });
});

describe('teamrig restore resume', () => {
  const CLAUDE = '/usr/local/bin/claude';
  const ON_PATH = new FakePathProbe({ folders: [APP], files: [CLAUDE] });
  const OPENER_ENV = { PATH: '/usr/local/bin', TEAMRIG_SESSION: 'lead', TEAMRIG_TEAM: 'app', TEAMRIG_LAUNCHED: 'lead', CLAUDECODE: '1' };

  it('resumes the session in its folder at its effort with its prompt, as none of the opener sessions', async () => {
    const processes = new FakeProcesses();
    const result = await new CliHarness(TEAM).run(['restore', 'resume', NOTES, '--project', APP, '--effort', 'high', '--encoded-prompt', encodePrompt('Go on')], { probe: ON_PATH, processes, env: OPENER_ENV });
    assert.deepEqual(result, { code: EXIT.ok, stdout: [`Resuming Claude Code session ${NOTES} in ${APP} at high effort`], stderr: [] });
    assert.deepEqual(processes.ran, [{ command: CLAUDE, args: ['--resume', NOTES, '--effort', 'high', 'Go on'], cwd: APP, env: { TEAMRIG_HOME: KIT, PATH: '/usr/local/bin' } }]);
  });

  it('resumes idle on the kit home it is given', async () => {
    const processes = new FakeProcesses();
    okResult(await new CliHarness(TEAM).run(['restore', 'resume', NOTES, '--project', APP, '--home', '/other/kit'], { probe: ON_PATH, processes, env: OPENER_ENV }));
    assert.deepEqual(processes.ran[0]?.args, ['--resume', NOTES]);
    assert.equal(processes.ran[0]?.env['TEAMRIG_HOME'], '/other/kit');
  });

  it("resumes without the opener's plugin bin folders on PATH", async () => {
    const processes = new FakeProcesses();
    const env = { ...OPENER_ENV, PATH: '/home/me/.claude/plugins/cache/teamrig/teamrig/0.75.0/bin:/usr/local/bin' };
    okResult(await new CliHarness(TEAM).run(['restore', 'resume', NOTES, '--project', APP], { probe: ON_PATH, processes, env }));
    assert.equal(processes.ran[0]?.env['PATH'], '/usr/local/bin');
  });

  it('refuses a folder that is gone and anything but a Claude Code session id', async () => {
    const kit = new CliHarness(TEAM);
    assert.equal((await kit.run(['restore', 'resume', NOTES, '--project', '/gone'], { probe: ON_PATH })).code, EXIT.refused);
    assert.equal((await kit.run(['restore', 'resume', 'not-an-id', '--project', APP], { probe: ON_PATH })).code, EXIT.usage);
  });
});
