import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { PLUGIN_ROOT_VAR, POSIX_LAUNCHER } from './dist-smoke.ts';

const CLI = fileURLToPath(new URL('./dist-smoke-cli.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = '1.2.3';

/** The repo's own launchers, so the smoke runs the shims the plugin ships. */
const LAUNCHERS = [POSIX_LAUNCHER, `${POSIX_LAUNCHER}.cmd`];

/**
 * A stand-in for the built CLI, which the launchers run: it takes its arguments as the real one does, rebuilt from the
 * cmd shim's line, then prints the version or names an unknown command with the usage exit.
 */
const MAIN = `import { CMD_SHIM_LINE_ENV, shimArgs } from ${JSON.stringify(new URL('../../src/cli/cmd-shim.ts', import.meta.url).href)};
const args = shimArgs(process.argv.slice(2), process.env[CMD_SHIM_LINE_ENV]);
if (args === undefined) {
  console.error('the command line was cut');
  process.exitCode = 64;
} else if (args[0] === '--version') {
  console.log('teamrig ${VERSION}');
} else {
  console.error('unknown command "' + args[0] + '"');
  process.exitCode = 64;
}
`;

/** One hook for every event: prints what dist-smoke expects of SessionStart and PreToolUse, nothing for the rest (Stop included). */
const HOOK = `let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const event = JSON.parse(input).hook_event_name;
  if (event === 'SessionStart') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart' } }));
  if (event === 'PreToolUse') console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny' } }));
});
`;

/** The hook command each event runs, named as in the plugin's hooks.json, since dist-smoke picks its sample by command. */
const COMMANDS: Readonly<Record<string, string>> = {
  SessionStart: 'session-start',
  PreToolUse: 'push-guard',
  UserPromptSubmit: 'inbox-reminder',
  Stop: 'stop',
  Notification: 'unsampled',
};

function manifest(events: readonly string[]): string {
  const groupOf = (event: string) => [
    { hooks: [{ type: 'command', command: 'node', args: [`${PLUGIN_ROOT_VAR}/hook.mjs`, 'hook', COMMANDS[event] ?? event] }] },
  ];
  return JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, groupOf(event)])) });
}

describe('dist-smoke-cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('dist-smoke').init();
  });
  afterEach(() => repo.remove());

  /** A built plugin with the repo's launchers running a stand-in CLI, and hooks that answer each event. */
  function writePlugin(events: readonly string[]): void {
    repo.write('plugins/teamrig/.claude-plugin/plugin.json', JSON.stringify({ name: 'teamrig', version: VERSION }));
    repo.write('plugins/teamrig/package.json', JSON.stringify({ type: 'module' }));
    repo.write('plugins/teamrig/hooks/hooks.json', manifest(events));
    repo.write('plugins/teamrig/hook.mjs', HOOK);
    repo.write('plugins/teamrig/dist/cli/main.js', MAIN);
    for (const launcher of LAUNCHERS) {
      repo.write(launcher, readFileSync(join(REPO_ROOT, ...launcher.split('/')), 'utf8'));
    }
  }

  it('passes a plugin whose launcher and hooks all run, with cmd.exe found on the PATH', () => {
    writePlugin(['SessionStart', 'PreToolUse', 'UserPromptSubmit', 'Stop']);
    chmodSync(join(repo.dir, ...POSIX_LAUNCHER.split('/')), 0o755);
    repo.git('add', '-A');
    repo.git('update-index', '--chmod=+x', POSIX_LAUNCHER);
    const result = repo.run(CLI, [], { ComSpec: undefined });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(result.stdout, `dist-smoke: the launcher and every hook run from the dist on ${process.platform}\n`);
  });

  it('lists a launcher that cannot start, a hook with no sample and a launcher committed without its executable bit', () => {
    writePlugin(['SessionStart', 'Notification']);
    repo.git('add', '-A');
    repo.git('update-index', '--chmod=-x', POSIX_LAUNCHER);
    // Neither launcher can start: the POSIX one has no executable bit, and cmd.exe is not where ComSpec says.
    const result = repo.run(CLI, [], { ComSpec: join(repo.outside, 'missing-cmd.exe') });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, new RegExp(`^dist-smoke: 4 problem\\(s\\) on ${process.platform}:$`, 'm'));
    assert.match(result.stdout, /^ {2}bin launcher --version: exit none: /m);
    assert.match(result.stdout, /^ {2}bin launcher with a multi-line argument: expected exit 64 and .*, got exit none /m);
    assert.match(result.stdout, /^ {2}Notification \(hook unsampled\): no smoke sample for hook unsampled; /m);
    assert.match(result.stdout, new RegExp(`^ {2}${POSIX_LAUNCHER} is committed with mode 100644, not 100755; `, 'm'));
  });

  it('exits 2 when plugin.json declares no version', () => {
    for (const plugin of ['{"name": "teamrig"}', '[]']) {
      repo.write('plugins/teamrig/.claude-plugin/plugin.json', plugin);
      const result = repo.run(CLI);
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, 'dist-smoke: plugin.json has no version\n');
    }
  });

  it('exits 2 with the error when there is no plugin.json', () => {
    const result = repo.run(CLI);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /^dist-smoke: ENOENT/);
  });
});
