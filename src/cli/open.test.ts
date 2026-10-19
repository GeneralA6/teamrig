import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { formatConfig } from '../config/load.ts';
import type { RunOutcome, RunRequest } from '../open/processes.ts';
import { decodePrompt, defaultPrompt, encodePrompt, refreshPrompt } from '../open/prompt.ts';
import { shellCommand } from '../open/quote.ts';
import { FakeHostMemory } from '../testing/fake-host-memory.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import type { RestartRequest } from '../refresh/state.ts';
import { RefreshStore } from '../refresh/store.ts';
import { APP, CLAUDE_SESSION, CliHarness, KIT, TEAM, TEAM_HOME, USER_HOME, type RunOptions } from '../testing/cli-harness.ts';
import { teamConfigOf, treeHarness } from '../testing/team-tree.ts';
import { EXIT } from './runtime.ts';

const NODE = '/usr/bin/node';
const SCRIPT = '/opt/teamrig/dist/cli/main.js';
const FOLDERS = new FakePathProbe({ folders: [APP] });

/** What `open alpha` hands the new tab to run, with the default prompt. */
function launchArgv(project: string = APP, prompt: string = defaultPrompt('app', 'alpha')): string[] {
  return [NODE, SCRIPT, 'launch', 'alpha', '--team', 'app', '--project', project, '--home', resolve(APP, KIT), '--encoded-prompt', encodePrompt(prompt)];
}

function openAlpha(processes: FakeProcesses, options: RunOptions = {}, extra: readonly string[] = []) {
  return new CliHarness(TEAM).run(['open', 'alpha', ...extra], { probe: FOLDERS, processes, ...options });
}

describe('teamrig open', () => {
  it('opens a Windows Terminal tab in the project that runs launch by absolute paths', async () => {
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
    const result = await openAlpha(processes, { platform: 'win32' });
    assert.deepEqual(result, { code: EXIT.ok, stdout: [`OPENED app-alpha (session alpha) in a new Windows Terminal tab in ${APP}, on the default model and effort`], stderr: [] });
    assert.deepEqual(processes.started, [
      { command: 'wt.exe', args: ['-w', '0', 'new-tab', '--title', 'app-alpha', '-d', APP, '--', ...launchArgv()], cwd: APP, mode: 'exit' },
    ]);
  });

  it('refuses a session the host has no room for, and opens the lead whatever the room', async () => {
    const memory = new FakeHostMemory();
    memory.free = 5000;
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
    const refused = await openAlpha(processes, { platform: 'win32', memory });
    assert.equal(refused.code, EXIT.refused);
    assert.deepEqual(refused.stdout, [
      'REFUSED no room on the host to open app-alpha (session alpha), counted at 1200 MB: 5000 MB free, under the 4096 MB heavy ' +
        'steps keep free (coordinator.heavy.memoryFloorMb) plus 1200 MB for it. Close a session first: teamrig sessions lists what each one holds',
    ]);
    assert.deepEqual(processes.started, []);
    const lead = await new CliHarness(TEAM).run(['open', 'lead'], { probe: FOLDERS, processes, platform: 'win32', memory });
    assert.equal(lead.code, EXIT.ok, lead.stdout.join('\n'));
    assert.equal(processes.started.length, 1);
  });

  it('opens a tmux window inside tmux, and a Terminal window on macOS', async () => {
    const tmux = new FakeProcesses().onStart('tmux', { kind: 'started' });
    const tmuxRun = await openAlpha(tmux, { env: { TMUX: '/tmp/tmux-1/default,1,0' } });
    assert.deepEqual(tmuxRun.stdout, [`OPENED app-alpha (session alpha) in a new tmux window in ${APP}, on the default model and effort`]);
    assert.deepEqual(tmux.started[0]?.args, ['new-window', '-c', APP, '-n', 'app-alpha', ...launchArgv()]);
    const mac = new FakeProcesses().onStart('osascript', { kind: 'started' });
    await openAlpha(mac, { platform: 'darwin' });
    assert.equal(mac.started[0]?.args.at(-1), shellCommand('darwin', APP, launchArgv()));
  });

  it('prints the command to run, and exits 3, when no terminal opens', async () => {
    const processes = new FakeProcesses();
    const result = await openAlpha(processes, { platform: 'win32' });
    assert.deepEqual(result, {
      code: EXIT.printed,
      stdout: ['MANUAL no terminal opened (windows-terminal is not installed); open a new terminal and run this in PowerShell:', shellCommand('win32', APP, launchArgv())],
      stderr: [],
    });
    const linux = await openAlpha(new FakeProcesses(), {}, ['--terminal', 'print']);
    assert.deepEqual(linux.stdout, ['MANUAL no terminal opened (the terminal setting is print); open a new terminal and run this:', shellCommand('linux', APP, launchArgv())]);
  });

  it('takes the terminal from the config, and the flag over it', async () => {
    const kit = new CliHarness({ ...TEAM, open: { terminal: 'print' } });
    const processes = new FakeProcesses().onStart('konsole', { kind: 'started' });
    const configured = await kit.run(['open', 'alpha'], { probe: FOLDERS, processes });
    assert.equal(configured.code, EXIT.printed);
    const flagged = await kit.run(['open', 'alpha', '--terminal', 'konsole'], { probe: FOLDERS, processes });
    assert.deepEqual(flagged.stdout, [`OPENED app-alpha (session alpha) in a new Konsole tab in ${APP}, on the default model and effort`]);
    assert.deepEqual(processes.started.map((request) => request.command), ['konsole']);
  });

  it('carries a hostile prompt and project folder as data, never as shell text', async () => {
    const folder = resolve('/', 'w', `a "b"; $(id) & %PATH% \`x\``);
    const prompt = `Fix "it"; rm -rf / & echo $(id) | cat %PATH%\nnext`;
    const processes = new FakeProcesses().onStart('gnome-terminal', { kind: 'started' });
    const probe = new FakePathProbe({ folders: [folder] });
    await openAlpha(processes, { probe }, ['--project', folder, '--prompt', prompt]);
    const argv = launchArgv(folder, prompt);
    assert.deepEqual(processes.started[0]?.args, ['--tab', `--working-directory=${folder}`, '--', ...argv]);
    assert.equal(decodePrompt(argv.at(-1) ?? ''), prompt);
    const windows = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
    const refused = await openAlpha(windows, { probe, platform: 'win32' }, ['--project', folder, '--prompt', prompt]);
    assert.equal(refused.code, EXIT.printed);
    assert.deepEqual(windows.started, []);
    assert.equal(refused.stdout[1], shellCommand('win32', folder, argv));
  });

  it('opens in the folder Claude Code started in when the team comes from $TEAMRIG_TEAM, and passes no kit home it was not given', async () => {
    const elsewhere = resolve('/', 'other');
    const processes = new FakeProcesses().onStart('gnome-terminal', { kind: 'started' });
    const kit = new CliHarness(TEAM, null);
    await kit.files.write(join(USER_HOME, '.teamrig', 'teams', 'app', 'config.json'), formatConfig(TEAM));
    const result = await kit.run(['open', 'alpha'], {
      env: { TEAMRIG_HOME: '', TEAMRIG_TEAM: 'app', CLAUDE_PROJECT_DIR: elsewhere },
      probe: new FakePathProbe({ folders: [elsewhere] }),
      processes,
    });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(processes.started[0]?.args.slice(3), [NODE, SCRIPT, 'launch', 'alpha', '--team', 'app', '--project', elsewhere, '--encoded-prompt', encodePrompt(defaultPrompt('app', 'alpha'))]);
  });

  it('refuses a session not on the team and a project that is not there; reads a bad flag as a usage error', async () => {
    const zulu = await new CliHarness(TEAM).run(['open', 'zulu'], { probe: FOLDERS });
    assert.equal(zulu.code, EXIT.refused);
    assert.match(zulu.stdout[0] ?? '', /^REFUSED .*zulu/);
    const gone = await new CliHarness(TEAM).run(['open', 'alpha']);
    assert.deepEqual(gone.stdout, [`REFUSED the project folder ${APP} does not exist`]);
    for (const [extra, message] of [
      [['--terminal', 'xterm'], '--terminal "xterm" is not one of auto, tmux, windows-terminal'],
      [['--prompt', '-p'], '--prompt: the prompt cannot start with -'],
      [['bravo'], 'unexpected "bravo"'],
    ] as const) {
      const result = await openAlpha(new FakeProcesses(), {}, extra);
      assert.equal(result.code, EXIT.usage);
      assert.ok(result.stderr[0]?.startsWith(message), result.stderr[0]);
    }
  });
});

describe('teamrig open <team>/<id>', () => {
  it('says the model and effort the lead of another team starts on', async () => {
    const kit = await treeHarness();
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
    const result = await kit.run(['open', 'web/lead'], { probe: FOLDERS, processes, platform: 'win32' });
    assert.deepEqual(result.stdout, [`OPENED web-lead (session lead) in a new Windows Terminal tab in ${APP}, on model opus at xhigh effort`]);
  });

  it('opens a session of another team of the tree in the same project, launched on its own team', async () => {
    const kit = await treeHarness();
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
    const result = await kit.run(['open', 'web/front'], { probe: FOLDERS, processes, platform: 'win32' });
    assert.deepEqual(result.stdout, [`OPENED web-front (session front) in a new Windows Terminal tab in ${APP}, on the default model and effort`]);
    assert.deepEqual(processes.started[0]?.args.slice(8), [
      NODE, SCRIPT, 'launch', 'front', '--team', 'web', '--project', APP, '--home', resolve(APP, KIT), '--encoded-prompt', encodePrompt(defaultPrompt('web', 'front')),
    ]);
    const own = await kit.run(['open', 'app/alpha'], { probe: FOLDERS, processes, platform: 'win32' });
    assert.equal(own.code, EXIT.ok);
  });

  it('refuses a team outside the tree or with no config', async () => {
    const kit = await treeHarness();
    await kit.files.write(teamConfigOf('blog'), formatConfig({ configVersion: 1, team: { id: 'blog' }, sessions: ['lead'], roles: { lead: 'lead' } }));
    for (const team of ['blog', 'gone']) {
      const result = await kit.run(['open', `${team}/lead`], { probe: FOLDERS });
      assert.deepEqual(result.stdout, [`REFUSED team ${team} is not in the tree of team app; open its sessions from its own project folder`]);
    }
  });
});

describe('teamrig launch', () => {
  const CLAUDE = '/usr/local/bin/claude';
  const LAUNCH = ['launch', 'alpha', '--team', 'app', '--project', APP];
  const ON_PATH = new FakePathProbe({ folders: [APP], files: [CLAUDE] });
  const SESSION_ENV = { TEAMRIG_HOME: KIT, PATH: '/usr/local/bin', TEAMRIG_SESSION: 'alpha', TEAMRIG_TEAM: 'app', TEAMRIG_LAUNCHED: 'alpha' };
  const ENDING: RestartRequest = { phase: 'ending', at: '2030-01-08T10:00:00.000Z', pid: 4100, claudeSession: 'c1', transcript: null, cwd: null, supervised: true };

  /** Claude Code whose first run the automatic restart ends, leaving `request` as `restart` does. */
  class RestartedOnce extends FakeProcesses {
    private readonly request: RestartRequest;
    readonly store: RefreshStore;

    constructor(kit: CliHarness, request: RestartRequest) {
      super();
      this.request = request;
      this.store = new RefreshStore(kit.files, { refresh: join(TEAM_HOME, 'state', 'refresh'), handover: join(TEAM_HOME, 'handover') });
    }

    override async run(request: RunRequest): Promise<RunOutcome> {
      if (this.ran.length === 0) {
        await this.store.setRestart('alpha', this.request);
      }
      return super.run(request);
    }
  }

  function launch(processes: FakeProcesses, extra: readonly string[] = [], options: RunOptions = {}) {
    return new CliHarness(TEAM).run([...LAUNCH, ...extra], { probe: ON_PATH, processes, env: { PATH: '/usr/local/bin', CLAUDECODE: '1' }, ...options });
  }

  it('starts Claude Code as the session, in the project, with its name and first prompt', async () => {
    const processes = new FakeProcesses();
    const result = await launch(processes, ['--encoded-prompt', encodePrompt('Build the "form"; then test')]);
    assert.deepEqual(result, { code: EXIT.ok, stdout: [`Starting Claude Code as app-alpha (session alpha of team app) in ${APP}, on the default model and effort`], stderr: [] });
    assert.deepEqual(processes.ran, [{ command: CLAUDE, args: ['--name', 'app-alpha', 'Build the "form"; then test'], cwd: APP, env: SESSION_ENV }]);
    assert.deepEqual(processes.started, []);
  });

  it("starts Claude Code without the opener's plugin bin folders on PATH, so the session's own teamrig answers its Bash calls", async () => {
    const processes = new FakeProcesses();
    await launch(processes, [], { env: { PATH: '/home/me/.claude/plugins/cache/teamrig/teamrig/0.75.0/bin:/usr/local/bin' } });
    assert.deepEqual(processes.ran.map((run) => run.env), [SESSION_ENV]);
  });

  it('starts Claude Code again, sent to its handover, once the automatic restart ended it, then ends with it', async () => {
    const kit = new CliHarness(TEAM);
    const processes = new RestartedOnce(kit, ENDING);
    const result = await kit.run([...LAUNCH, '--encoded-prompt', encodePrompt('Build it')], { probe: ON_PATH, processes, env: { PATH: '/usr/local/bin' } });
    assert.deepEqual(result, {
      code: EXIT.ok,
      stdout: [
        `Starting Claude Code as app-alpha (session alpha of team app) in ${APP}, on the default model and effort`,
        'Starting Claude Code again as app-alpha with a fresh context: it reads its handover first',
      ],
      stderr: [],
    });
    assert.deepEqual(
      processes.ran.map((run) => run.args.at(-1)),
      ['Build it', refreshPrompt('app', 'alpha', processes.store.handoverPath('alpha'))],
    );
    assert.equal(await processes.store.restart('alpha'), undefined);
  });

  it('resumes the Claude Code session it is given on the first start only: the restart starts fresh', async () => {
    const kit = new CliHarness(TEAM);
    const processes = new RestartedOnce(kit, ENDING);
    const result = await kit.run([...LAUNCH, '--resume', CLAUDE_SESSION, '--encoded-prompt', encodePrompt('Go on')], { probe: ON_PATH, processes, env: { PATH: '/usr/local/bin' } });
    assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
    assert.equal(result.stdout[0], `Starting Claude Code as app-alpha (session alpha of team app) in ${APP}, on the default model and effort, resuming Claude Code session ${CLAUDE_SESSION}`);
    assert.deepEqual(processes.ran[0]?.args, ['--resume', CLAUDE_SESSION, '--name', 'app-alpha', 'Go on']);
    assert.deepEqual(processes.ran[1]?.args, ['--name', 'app-alpha', refreshPrompt('app', 'alpha', processes.store.handoverPath('alpha'))]);
  });

  it('ends with Claude Code when no restart ended it for launch', async () => {
    const unsupervised: RestartRequest = { ...ENDING, supervised: false };
    const pending: RestartRequest = { ...ENDING, phase: 'pending' };
    for (const request of [unsupervised, pending]) {
      const kit = new CliHarness(TEAM);
      const processes = new RestartedOnce(kit, request);
      assert.equal((await kit.run(LAUNCH, { probe: ON_PATH, processes, env: { PATH: '/usr/local/bin' } })).code, EXIT.ok);
      assert.equal(processes.ran.length, 1, request.phase);
      assert.deepEqual(await processes.store.restart('alpha'), request, 'left for the restart that owns it');
    }
  });

  it('starts at the effort --effort names over the configured one, and with no first prompt on --no-prompt', async () => {
    const processes = new FakeProcesses();
    const kit = new CliHarness({ ...TEAM, launch: { alpha: { model: 'sonnet', effort: 'high' } } });
    const result = await kit.run([...LAUNCH, '--effort', 'max', '--no-prompt'], { probe: ON_PATH, processes, env: { PATH: '/usr/local/bin' } });
    assert.deepEqual(result.stdout, [`Starting Claude Code as app-alpha (session alpha of team app) in ${APP}, on model sonnet at max effort`]);
    assert.deepEqual(processes.ran[0]?.args, ['--model', 'sonnet', '--effort', 'max', '--name', 'app-alpha']);
  });

  it('starts the lead on Opus at xhigh effort, and any session on its configured model and effort', async () => {
    const lead = new FakeProcesses();
    const result = await new CliHarness(TEAM).run(['launch', 'lead', '--team', 'app', '--project', APP], { probe: ON_PATH, processes: lead, env: { PATH: '/usr/local/bin' } });
    assert.deepEqual(result.stdout, [`Starting Claude Code as app-lead (session lead of team app) in ${APP}, on model opus at xhigh effort`]);
    assert.deepEqual(lead.ran[0]?.args, ['--model', 'opus', '--effort', 'xhigh', '--name', 'app-lead', defaultPrompt('app', 'lead')]);
    const alpha = new FakeProcesses();
    const configured = await new CliHarness({ ...TEAM, launch: { alpha: { model: 'sonnet', effort: 'high' } } }).run(LAUNCH, { probe: ON_PATH, processes: alpha, env: { PATH: '/usr/local/bin' } });
    assert.deepEqual(configured.stdout, [`Starting Claude Code as app-alpha (session alpha of team app) in ${APP}, on model sonnet at high effort`]);
    assert.deepEqual(alpha.ran[0]?.args, ['--model', 'sonnet', '--effort', 'high', '--name', 'app-alpha', defaultPrompt('app', 'alpha')]);
  });

  it('runs the script behind an npm claude.cmd with Node.js on Windows, with the default prompt', async () => {
    const kit = new CliHarness(TEAM);
    const cli = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
    await kit.files.write('C:\\npm\\claude.cmd', '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    const processes = new FakeProcesses();
    const result = await kit.run(LAUNCH, {
      platform: 'win32',
      env: { PATH: 'C:\\npm' },
      probe: new FakePathProbe({ folders: [APP], files: ['C:\\npm\\claude.cmd', cli] }),
      processes,
    });
    assert.equal(result.code, EXIT.ok, result.stdout.join('\n'));
    assert.deepEqual(processes.ran[0]?.command, NODE);
    assert.deepEqual(processes.ran[0]?.args, [cli, '--name', 'app-alpha', defaultPrompt('app', 'alpha')]);
  });

  it('uses the kit home it is given', async () => {
    const result = await launch(new FakeProcesses(), ['--home', join('/', 'elsewhere')]);
    assert.equal(result.code, EXIT.refused);
    assert.match(result.stdout[0] ?? '', /^REFUSED no team config at .*elsewhere/);
  });

  it('reports how Claude Code ended when it did not exit cleanly', async () => {
    const cases = [
      [{ kind: 'exited', code: 7 }, 'FAILED Claude Code exited with code 7'],
      [{ kind: 'failed', error: 'EACCES' }, `FAILED ${CLAUDE}: EACCES`],
      [{ kind: 'missing' }, `FAILED ${CLAUDE} is gone`],
    ] as const;
    for (const [outcome, line] of cases) {
      const result = await launch(new FakeProcesses().onRun(CLAUDE, outcome));
      assert.deepEqual([result.code, result.stderr], [EXIT.failed, [line]]);
    }
  });

  it('refuses when Claude Code is not on PATH, naming what it skipped', async () => {
    const plain = await launch(new FakeProcesses(), [], { probe: FOLDERS });
    assert.deepEqual(plain.stdout, ['REFUSED Claude Code (claude) is not on PATH; install it, then run this again']);
    const kit = new CliHarness(TEAM);
    await kit.files.write('C:\\x\\claude.cmd', 'claude-code %*');
    const skipped = await kit.run(LAUNCH, { platform: 'win32', env: { PATH: 'C:\\x' }, probe: new FakePathProbe({ folders: [APP], files: ['C:\\x\\claude.cmd'] }) });
    assert.deepEqual(skipped.stdout, ['REFUSED Claude Code (claude) is not on PATH (skipped: C:\\x\\claude.cmd is not an npm launcher); install it, then run this again']);
  });

  it('refuses a session not on the team or a missing project; reads a bad line as a usage error', async () => {
    const zulu = await new CliHarness(TEAM).run(['launch', 'zulu', '--team', 'app', '--project', APP], { probe: ON_PATH });
    assert.deepEqual(zulu.stdout, ['REFUSED zulu is not a session of team app']);
    const gone = await launch(new FakeProcesses(), [], { probe: new FakePathProbe() });
    assert.deepEqual(gone.stdout, [`REFUSED the project folder ${APP} does not exist`]);
    for (const [argv, message] of [
      [['launch', 'Alpha!', '--team', 'app', '--project', APP], 'session "Alpha!" is not an id'],
      [['launch', 'alpha', '--team', 'App', '--project', APP], '--team "App" is not an id'],
      [['launch', 'alpha', '--team', 'app'], '--project is required'],
      [[...LAUNCH, '--encoded-prompt', 'a+b'], '--encoded-prompt is not a prompt that teamrig open wrote'],
      [[...LAUNCH, '--encoded-prompt', encodePrompt('-p')], '--prompt: the prompt cannot start with -'],
      [[...LAUNCH, '--resume', 'c1'], '--resume "c1" is not a Claude Code session id'],
      [[...LAUNCH, '--effort', 'turbo'], '--effort "turbo" is not an effort level'],
      [[...LAUNCH, '--no-prompt', '--encoded-prompt', encodePrompt('Go on')], '--no-prompt and --encoded-prompt cannot go together'],
    ] as const) {
      const result = await new CliHarness(TEAM).run(argv, { probe: ON_PATH });
      assert.equal(result.code, EXIT.usage, argv.join(' '));
      assert.ok(result.stderr[0]?.startsWith(message), result.stderr[0]);
    }
  });
});
