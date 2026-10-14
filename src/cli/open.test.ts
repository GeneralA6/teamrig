import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { formatConfig } from '../config/load.ts';
import { decodePrompt, defaultPrompt, encodePrompt } from '../open/prompt.ts';
import { shellCommand } from '../open/quote.ts';
import { FakePathProbe, FakeProcesses } from '../testing/fake-processes.ts';
import { APP, CliHarness, KIT, TEAM, USER_HOME, type RunOptions } from '../testing/cli-harness.ts';
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
    assert.deepEqual(result, { code: EXIT.ok, stdout: [`OPENED app-alpha (session alpha) in a new Windows Terminal tab in ${APP}`], stderr: [] });
    assert.deepEqual(processes.started, [
      { command: 'wt.exe', args: ['-w', '0', 'new-tab', '--title', 'app-alpha', '-d', APP, '--', ...launchArgv()], cwd: APP, mode: 'exit' },
    ]);
  });

  it('opens a tmux window inside tmux, and a Terminal window on macOS', async () => {
    const tmux = new FakeProcesses().onStart('tmux', { kind: 'started' });
    const tmuxRun = await openAlpha(tmux, { env: { TMUX: '/tmp/tmux-1/default,1,0' } });
    assert.deepEqual(tmuxRun.stdout, [`OPENED app-alpha (session alpha) in a new tmux window in ${APP}`]);
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
    assert.deepEqual(flagged.stdout, [`OPENED app-alpha (session alpha) in a new Konsole tab in ${APP}`]);
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
  it('opens a session of another team of the tree in the same project, launched on its own team', async () => {
    const kit = await treeHarness();
    const processes = new FakeProcesses().onStart('wt.exe', { kind: 'started' });
    const result = await kit.run(['open', 'web/front'], { probe: FOLDERS, processes, platform: 'win32' });
    assert.deepEqual(result.stdout, [`OPENED web-front (session front) in a new Windows Terminal tab in ${APP}`]);
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
  const SESSION_ENV = { TEAMRIG_HOME: KIT, PATH: '/usr/local/bin', TEAMRIG_SESSION: 'alpha', TEAMRIG_TEAM: 'app' };

  function launch(processes: FakeProcesses, extra: readonly string[] = [], options: RunOptions = {}) {
    return new CliHarness(TEAM).run([...LAUNCH, ...extra], { probe: ON_PATH, processes, env: { PATH: '/usr/local/bin', CLAUDECODE: '1' }, ...options });
  }

  it('starts Claude Code as the session, in the project, with its name and first prompt', async () => {
    const processes = new FakeProcesses();
    const result = await launch(processes, ['--encoded-prompt', encodePrompt('Build the "form"; then test')]);
    assert.deepEqual(result, { code: EXIT.ok, stdout: [`Starting Claude Code as app-alpha (session alpha of team app) in ${APP}`], stderr: [] });
    assert.deepEqual(processes.ran, [{ command: CLAUDE, args: ['--name', 'app-alpha', 'Build the "form"; then test'], cwd: APP, env: SESSION_ENV }]);
    assert.deepEqual(processes.started, []);
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
    ] as const) {
      const result = await new CliHarness(TEAM).run(argv, { probe: ON_PATH });
      assert.equal(result.code, EXIT.usage, argv.join(' '));
      assert.ok(result.stderr[0]?.startsWith(message), result.stderr[0]);
    }
  });
});
