import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter, join } from 'node:path';
import type { RunRequest, RunResult } from './dist-smoke.ts';
import { cmdArg, freshInstall, installEnv, installSteps, layoutOf, teamrigRequest, type InstallInput } from './fresh-install.ts';

const HOME = join('scratch', 'home');
const { clone, plugin, project } = layoutOf(HOME);

function inputOf(platform: NodeJS.Platform): InstallInput {
  return { platform, source: 'file:///work/teamrig', home: HOME, path: join('usr', 'bin'), nodePath: 'node', comspec: 'cmd.exe' };
}

/** hooks.json with one exec-form hook per event, as the plugin ships it. */
const MANIFEST = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/main.js', 'hook', 'session-start'] }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/hooks/main.js', 'hook', 'push-guard'] }] }],
  },
};

interface Call {
  readonly request: RunRequest;
  readonly cwd: string;
}

/**
 * A runner that answers each install step with the text it expects and each hook with nothing, recording every
 * call; `override` changes the answer to the step or hook whose args include it.
 */
function fakeRunner(input: InstallInput, override?: { readonly arg: string; readonly result: RunResult }): { readonly calls: Call[]; readonly run: (request: RunRequest, cwd: string) => RunResult } {
  const expected = new Map(installSteps(input).map((step) => [JSON.stringify(step.request), step.expect ?? '']));
  const calls: Call[] = [];
  return {
    calls,
    run: (request, cwd) => {
      calls.push({ request, cwd });
      if (override !== undefined && request.args.some((arg) => arg.includes(override.arg))) {
        return override.result;
      }
      return { status: 0, stdout: expected.get(JSON.stringify(request)) ?? '', stderr: '' };
    },
  };
}

describe('installSteps', () => {
  it('clones the source into the home, then runs a bare teamrig from the PATH in the new project', () => {
    const steps = installSteps(inputOf('linux'));
    assert.deepEqual(steps[0], {
      label: 'git clone, no login',
      request: { file: 'git', args: ['clone', '-q', '--depth', '1', 'file:///work/teamrig', clone], input: '' },
      cwd: HOME,
    });
    // The new project holds no file, so its first commit is an empty one: a plain commit there exits 1.
    assert.deepEqual(steps.find((step) => step.label === 'git commit the project'), {
      label: 'git commit the project',
      request: { file: 'git', args: ['commit', '-q', '--allow-empty', '-m', 'init'], input: '' },
      cwd: project,
    });
    const create = steps.find((step) => step.label === 'team create');
    assert.deepEqual(create, {
      label: 'team create',
      request: { file: 'teamrig', args: ['team', 'create', 'demo', '--sessions', 'lead,web', '--project', project], input: '' },
      cwd: project,
      expect: 'ADDED T1 Set up the team',
    });
    assert.deepEqual(
      steps.map((step) => step.label),
      [
        'git clone, no login',
        'teamrig --version, bare on the PATH',
        'git init the project',
        'git commit the project',
        'team create',
        'start',
        'add',
        'list',
        'set',
        'inbox read',
      ],
    );
  });

  it('runs the .cmd launcher through cmd.exe on Windows, each argument as cmd takes it', () => {
    const create = installSteps(inputOf('win32')).find((step) => step.label === 'team create');
    assert.deepEqual(create?.request, {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `"teamrig team create demo --sessions "lead,web" --project ${project}"`],
      input: '',
      verbatim: true,
    });
  });
});

describe('teamrigRequest', () => {
  it('quotes an argument with a space on Windows, and leaves it whole elsewhere', () => {
    assert.deepEqual(teamrigRequest(inputOf('darwin'), ['--title', 'a b']), { file: 'teamrig', args: ['--title', 'a b'], input: '' });
    assert.deepEqual(teamrigRequest(inputOf('win32'), ['--title', 'a b']).args, ['/d', '/s', '/c', '"teamrig --title "a b""']);
  });
});

describe('cmdArg', () => {
  it('quotes an empty argument and one with a space or a comma, and leaves a plain one or a short path as is', () => {
    assert.equal(cmdArg(''), '""');
    assert.equal(cmdArg('a b'), '"a b"');
    assert.equal(cmdArg('lead,web'), '"lead,web"');
    assert.equal(cmdArg('D:\\a\\RUNNER~1\\x-y.z'), 'D:\\a\\RUNNER~1\\x-y.z');
  });

  it('refuses an argument holding a character cmd.exe reads', () => {
    for (const arg of ['a&b', 'a|b', '"a"', '%PATH%', 'a^b', 'a<b', 'a>b', 'a\nb']) {
      assert.throws(() => cmdArg(arg), /holds a character cmd\.exe would read/, arg);
    }
  });
});

describe('installEnv', () => {
  it('points every tool at the scratch home, puts the plugin bin first on PATH, and keeps no kit variable of the runner', () => {
    const env = installEnv(inputOf('linux'), { TEAMRIG_HOME: 'mine', TEAMRIG_TEAM: 'mine', SystemRoot: 'C:\\Windows', TMPDIR: 'tmp', UNRELATED: 'x' });
    assert.deepEqual(env, {
      SystemRoot: 'C:\\Windows',
      TMPDIR: 'tmp',
      HOME: HOME,
      USERPROFILE: HOME,
      PATH: [join(plugin, 'bin'), join('usr', 'bin')].join(delimiter),
      TEAMRIG_HOME: join(HOME, '.teamrig'),
      TEAMRIG_TEAM: 'demo',
      TEAMRIG_SESSION: 'lead',
      CLAUDE_CONFIG_DIR: join(HOME, '.claude'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    });
  });
});

describe('freshInstall', () => {
  it('runs every step, then each hook of the cloned plugin in the new project with a fresh tab payload', () => {
    const input = inputOf('linux');
    const { calls, run } = fakeRunner(input);
    const read: string[] = [];
    const report = freshInstall(input, run, (root) => {
      read.push(root);
      return MANIFEST;
    });
    assert.deepEqual(report.findings, []);
    assert.deepEqual(read, [plugin]);
    assert.equal(report.log.length, 12);
    assert.equal(report.log[0], 'exit 0 git clone, no login');
    assert.equal(report.log[11], 'exit 0 PreToolUse hook (hook push-guard)');
    const hook = calls[11];
    assert.deepEqual(hook?.request.args, [`${plugin}/dist/hooks/main.js`, 'hook', 'push-guard']);
    assert.equal(hook?.request.file, 'node');
    assert.equal(hook?.cwd, project);
    const payload: unknown = JSON.parse(hook?.request.input ?? '');
    assert.deepEqual(payload, {
      session_id: '00000000-0000-4000-8000-0000000000f1',
      transcript_path: join(project, 'transcript.jsonl'),
      cwd: project,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
      tool_response: { stdout: '', stderr: '', exitCode: 0 },
      prompt: 'hello',
      source: 'startup',
      stop_hook_active: false,
    });
  });

  it('stops at the first failed step, naming its exit and output, since each step needs the one before', () => {
    const input = inputOf('linux');
    const { calls, run } = fakeRunner(input, { arg: 'create', result: { status: 1, stdout: '', stderr: 'no such project\n' } });
    const report = freshInstall(input, run, () => assert.fail('no hook runs after a failed step'));
    assert.deepEqual(report.findings, ['team create: exit 1: no such project']);
    assert.equal(report.log.at(-1), 'exit 1 team create');
    assert.equal(calls.length, 5);
  });

  it('fails a step that exits 0 without the text it must print, and one that could not start', () => {
    const input = inputOf('linux');
    const quiet = freshInstall(input, fakeRunner(input, { arg: 'inbox', result: { status: 0, stdout: 'READ web: nothing new\n', stderr: '' } }).run, () => MANIFEST);
    assert.deepEqual(quiet.findings, ['inbox read: expected "T2 is yours (p1): Build the signup form" in its output, got "READ web: nothing new"']);
    const missing = freshInstall(input, fakeRunner(input, { arg: 'clone', result: { status: null, stdout: '', stderr: '' } }).run, () => MANIFEST);
    assert.deepEqual(missing.findings, ['git clone, no login: exit none']);
  });

  it('lists every failed hook and a hook not in exec form, and runs the rest', () => {
    const input = inputOf('linux');
    const manifest = { hooks: { ...MANIFEST.hooks, Stop: [{ hooks: [{ type: 'command', command: 'node hook stop' }] }] } };
    const report = freshInstall(input, fakeRunner(input, { arg: 'session-start', result: { status: 2, stdout: '', stderr: 'boom' } }).run, () => manifest);
    assert.equal(report.findings.length, 2);
    assert.match(report.findings[0] ?? '', /^Stop: a hook is not exec form/);
    assert.equal(report.findings[1], 'SessionStart hook (hook session-start): exit 2: boom');
    assert.equal(report.log.at(-1), 'exit 0 PreToolUse hook (hook push-guard)');
  });
});
