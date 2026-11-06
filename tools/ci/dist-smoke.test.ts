import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FakeGit } from '../lib/fake-git.ts';
import { MULTI_LINE_ARG, POSIX_LAUNCHER, hookCommandsOf, launcherModeFinding, smokeDist, type RunRequest, type RunResult, type Runner, type SmokeInput } from './dist-smoke.ts';

const ROOT = resolve('/plugin');

function execHook(name: string): { readonly type: string; readonly command: string; readonly args: readonly string[] } {
  return { type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js', 'hook', name] };
}

function manifestOf(events: Readonly<Record<string, readonly unknown[]>>): unknown {
  return { hooks: Object.fromEntries(Object.entries(events).map(([event, hooks]) => [event, [{ hooks }]])) };
}

const MANIFEST = manifestOf({
  SessionStart: [execHook('session-start')],
  PreToolUse: [execHook('push-guard')],
  UserPromptSubmit: [execHook('inbox-reminder')],
  Stop: [execHook('stop')],
});

function input(overrides: Partial<SmokeInput> = {}): SmokeInput {
  return { platform: 'linux', pluginRoot: ROOT, manifest: MANIFEST, version: '1.2.3', nodePath: '/usr/bin/node', comspec: 'C:\\cmd.exe', ...overrides };
}

const OK: RunResult = { status: 0, stdout: '', stderr: '' };

/** The CLI's answer to the multi-line argument handed over whole: an unknown command, then the usage. */
const UNKNOWN_MULTI_LINE: RunResult = { status: 64, stdout: '', stderr: `unknown command "${MULTI_LINE_ARG}"\n\nteamrig <command> ...\n` };

/** Answers like a healthy dist; `override` replaces the answer to the request whose args end with the given word. */
class FakeRunner {
  readonly requests: RunRequest[] = [];
  private readonly overrides: ReadonlyMap<string, RunResult>;

  constructor(overrides: Readonly<Record<string, RunResult>> = {}) {
    this.overrides = new Map(Object.entries(overrides));
  }

  readonly run = (request: RunRequest): RunResult => {
    this.requests.push(request);
    const last = request.args.at(-1) ?? '';
    const word = last.endsWith('--version"') ? '--version' : last.includes(MULTI_LINE_ARG) ? MULTI_LINE_ARG : last;
    const override = this.overrides.get(word);
    if (override !== undefined) {
      return override;
    }
    switch (word) {
      case '--version':
        return { ...OK, stdout: 'teamrig 1.2.3\n' };
      case MULTI_LINE_ARG:
        return UNKNOWN_MULTI_LINE;
      case 'session-start':
        return { ...OK, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'rules' } }) };
      case 'subagent-start':
        return { ...OK, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: 'rules' } }) };
      case 'missing-cli':
        return { ...OK, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: 'path' } }) };
      case 'secret-redact':
        return { ...OK, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { stdout: '[redacted GitHub token]' } } }) };
      case 'push-guard':
      case 'package-guard':
      case 'secret-guard':
      case 'exec-guard':
      case 'pass-record-guard':
        return { ...OK, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }) };
      default:
        return OK;
    }
  };
}

describe('hookCommandsOf', () => {
  it('fills in the plugin folder for each exec-form hook', () => {
    const { commands, findings } = hookCommandsOf(MANIFEST, ROOT);
    assert.deepEqual(findings, []);
    assert.deepEqual(commands, [
      { event: 'SessionStart', args: [`${ROOT}/dist/cli/main.js`, 'hook', 'session-start'] },
      { event: 'PreToolUse', args: [`${ROOT}/dist/cli/main.js`, 'hook', 'push-guard'] },
      { event: 'UserPromptSubmit', args: [`${ROOT}/dist/cli/main.js`, 'hook', 'inbox-reminder'] },
      { event: 'Stop', args: [`${ROOT}/dist/cli/main.js`, 'hook', 'stop'] },
    ]);
  });

  it('reports a hook that goes through a shell', () => {
    const shell = { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli/main.js" hook push-guard' };
    const { commands, findings } = hookCommandsOf(manifestOf({ PreToolUse: [shell] }), ROOT);
    assert.deepEqual(commands, []);
    assert.equal(findings.length, 1);
    assert.match(findings[0] ?? '', /^PreToolUse: a hook is not exec form/);
  });

  it('reports a manifest without hooks', () => {
    assert.deepEqual(hookCommandsOf({ description: 'x' }, ROOT).findings, ['hooks.json has no "hooks" object']);
  });

  it("keeps the plugin's own hooks.json in exec form, with a smoke sample for each hook", async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL('../../plugins/teamrig/hooks/hooks.json', import.meta.url), 'utf8'));
    const { commands, findings } = hookCommandsOf(manifest, ROOT);
    assert.deepEqual(findings, []);
    assert.ok(commands.length >= 4);
    const runner = new FakeRunner();
    assert.deepEqual(smokeDist(input({ manifest }), runner.run), []);
  });

  it("reports wrong output from every hook in the plugin's own hooks.json, except the reminder, whose output is free", async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL('../../plugins/teamrig/hooks/hooks.json', import.meta.url), 'utf8'));
    const healthy = new FakeRunner();
    const garbled: Runner = (request) => (request.file === input().nodePath ? { ...OK, stdout: 'garbled' } : healthy.run(request));
    const judged = hookCommandsOf(manifest, ROOT).commands.filter(({ args }) => args.at(-1) !== 'inbox-reminder');
    const findings = smokeDist(input({ manifest }), garbled);
    assert.deepEqual(
      findings.map((finding) => finding.split(': ')[0]),
      judged.map(({ event, args }) => `${event} (${args.slice(1).join(' ')})`),
    );
  });
});

describe('smokeDist', () => {
  it('finds nothing wrong with a healthy dist', () => {
    const runner = new FakeRunner();
    assert.deepEqual(smokeDist(input(), runner.run), []);
    assert.deepEqual(
      runner.requests.map((request) => [request.file, ...request.args]),
      [
        [join(ROOT, 'bin', 'teamrig'), '--version'],
        [join(ROOT, 'bin', 'teamrig'), MULTI_LINE_ARG],
        ['/usr/bin/node', `${ROOT}/dist/cli/main.js`, 'hook', 'session-start'],
        ['/usr/bin/node', `${ROOT}/dist/cli/main.js`, 'hook', 'push-guard'],
        ['/usr/bin/node', `${ROOT}/dist/cli/main.js`, 'hook', 'inbox-reminder'],
        ['/usr/bin/node', `${ROOT}/dist/cli/main.js`, 'hook', 'stop'],
      ],
    );
    assert.equal(runner.requests[2]?.input, JSON.stringify({ hook_event_name: 'SessionStart', session_id: '0123abcd-0000-4000-8000-00000000000a', source: 'startup' }));
  });

  it('runs the .cmd launcher through cmd.exe on Windows, args passed as written and one with a space quoted', () => {
    const runner = new FakeRunner();
    assert.deepEqual(smokeDist(input({ platform: 'win32' }), runner.run), []);
    const launcher = `"${join(ROOT, 'bin', 'teamrig.cmd')}"`;
    assert.deepEqual(runner.requests.slice(0, 2), [
      { file: 'C:\\cmd.exe', args: ['/d', '/s', '/c', `"${launcher} --version"`], input: '', verbatim: true },
      { file: 'C:\\cmd.exe', args: ['/d', '/s', '/c', `"${launcher} "${MULTI_LINE_ARG}""`], input: '', verbatim: true },
    ]);
  });

  it('reports a launcher that cuts a multi-line argument at the line break, or runs it', () => {
    const cut = new FakeRunner({ [MULTI_LINE_ARG]: { status: 64, stdout: '', stderr: 'unknown command "no"\n\nteamrig <command> ...\n' } });
    const expected = `expected exit 64 and ${JSON.stringify(`unknown command "${MULTI_LINE_ARG}"`)}`;
    assert.deepEqual(smokeDist(input(), cut.run), [`bin launcher with a multi-line argument: ${expected}, got exit 64 and "unknown command \\"no\\""`]);
    const ran = new FakeRunner({ [MULTI_LINE_ARG]: OK });
    assert.deepEqual(smokeDist(input(), ran.run), [`bin launcher with a multi-line argument: ${expected}, got exit 0 and ""`]);
  });

  it('reports a launcher that cannot start or prints another version', () => {
    const denied = new FakeRunner({ '--version': { status: null, stdout: '', stderr: 'spawnSync /plugin/bin/teamrig EACCES' } });
    assert.deepEqual(smokeDist(input(), denied.run), ['bin launcher --version: exit none: spawnSync /plugin/bin/teamrig EACCES']);
    const stale = new FakeRunner({ '--version': { ...OK, stdout: 'teamrig 1.2.2\n' } });
    assert.deepEqual(smokeDist(input(), stale.run), ['bin launcher --version: printed "teamrig 1.2.2", expected "teamrig 1.2.3"']);
  });

  it('reports a hook that fails, writes to stderr or prints the wrong output', () => {
    const runner = new FakeRunner({
      'session-start': { status: 1, stdout: '', stderr: 'boom' },
      'inbox-reminder': { ...OK, stderr: 'warning' },
      'push-guard': { ...OK, stdout: '' },
      stop: { ...OK, stdout: '{"decision":"block"}' },
    });
    assert.deepEqual(smokeDist(input(), runner.run), [
      'SessionStart (hook session-start): exit 1: boom',
      'PreToolUse (hook push-guard): expected a deny for a force-push of main',
      'UserPromptSubmit (hook inbox-reminder): wrote to stderr: warning',
      'Stop (hook stop): expected no output, got "{\\"decision\\":\\"block\\"}"',
    ]);
  });

  it('reports a hook that is off without a config but still printed', () => {
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    const runner = new FakeRunner({ 'readonly-allow': { ...OK, stdout: deny }, 'picker-guard': { ...OK, stdout: deny } });
    const manifest = manifestOf({ PreToolUse: [execHook('readonly-allow'), execHook('picker-guard')] });
    assert.deepEqual(smokeDist(input({ manifest }), runner.run), [
      `PreToolUse (hook readonly-allow): expected no output with the hook off, got ${JSON.stringify(deny)}`,
      `PreToolUse (hook picker-guard): expected no output with the guard off, got ${JSON.stringify(deny)}`,
    ]);
    assert.deepEqual(smokeDist(input({ manifest }), new FakeRunner().run), []);
  });

  it('reports a start hook that ran but added no context', () => {
    const runner = new FakeRunner({ 'session-start': OK });
    assert.deepEqual(smokeDist(input(), runner.run), ['SessionStart (hook session-start): expected SessionStart additionalContext']);
  });

  it('asks for a sample when the manifest adds an event the smoke test does not know', () => {
    const runner = new FakeRunner();
    const findings = smokeDist(input({ manifest: manifestOf({ Notification: [execHook('unsampled')] }) }), runner.run);
    assert.deepEqual(findings, ['Notification (hook unsampled): no smoke sample for hook unsampled; add one to tools/ci/dist-smoke.ts']);
  });
});

describe('launcherModeFinding', () => {
  const LS = `ls-files --stage -- ${POSIX_LAUNCHER}`;

  it('accepts a launcher committed executable', async () => {
    assert.equal(await launcherModeFinding(new FakeGit({ [LS]: `100755 e90e 0	${POSIX_LAUNCHER}
` })), undefined);
  });

  it('reports a launcher committed without the executable bit, or not at all', async () => {
    assert.equal(
      await launcherModeFinding(new FakeGit({ [LS]: `100644 e90e 0	${POSIX_LAUNCHER}
` })),
      `${POSIX_LAUNCHER} is committed with mode 100644, not 100755; run git update-index --chmod=+x ${POSIX_LAUNCHER}`,
    );
    assert.equal(await launcherModeFinding(new FakeGit({ [LS]: '' })), `${POSIX_LAUNCHER} is not committed`);
  });
});
