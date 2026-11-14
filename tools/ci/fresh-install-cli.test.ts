import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempRepo } from '../lib/temp-repo.ts';
import { PLUGIN_ROOT_VAR, POSIX_LAUNCHER } from './dist-smoke.ts';

const CLI = fileURLToPath(new URL('./fresh-install-cli.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The repo's own launchers, so the run starts the shims the plugin ships. */
const LAUNCHERS = [POSIX_LAUNCHER, `${POSIX_LAUNCHER}.cmd`];

/**
 * A stand-in for the built CLI: it takes its arguments as the real one does, rebuilt from the cmd shim's line, checks
 * it runs in the new team with the title whole, and prints what the real one prints for each step; `fail` names a
 * command it fails instead.
 */
function main(fail: string): string {
  return `import { CMD_SHIM_LINE_ENV, shimArgs } from ${JSON.stringify(new URL('../../src/cli/cmd-shim.ts', import.meta.url).href)};
const args = shimArgs(process.argv.slice(2), process.env[CMD_SHIM_LINE_ENV]) ?? [];
const said = {
  '--version': 'teamrig 1.2.3',
  team: 'ADDED T1 Set up the team, in progress, owner lead',
  start: 'START lead, Sat 11-14 16:50 IST',
  add: args.includes('Build the signup form') ? 'ADDED T2 open, p1, owner web, from lead | Build the signup form' : 'the title was cut',
  list: 'T2 open, Improvements, score 3.33, p1, owner web | Build the signup form',
  set: 'SET T2 in-progress, p1, owner web, from lead | Build the signup form',
  inbox: '- lead: T2 is yours (p1): Build the signup form',
};
if (args[0] === ${JSON.stringify(fail)} || process.env.TEAMRIG_TEAM !== 'demo') {
  console.error(args[0] + ' failed in team ' + process.env.TEAMRIG_TEAM);
  process.exitCode = 1;
} else {
  console.log(said[args[0]] ?? 'unknown command');
}
`;
}

/** A hook that reads its payload and exits 0, as each real one does on a fresh tab. */
const HOOK = `process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;

const MANIFEST = JSON.stringify({
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node', args: [`${PLUGIN_ROOT_VAR}/hook.mjs`, 'hook', 'session-start'] }] }] },
});

describe('fresh-install-cli', () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = new TempRepo('fresh-install').init();
  });
  afterEach(() => repo.remove());

  /** Commits a plugin with the repo's launchers, the stand-in CLI and one hook, as the clone takes it. */
  function commitPlugin(fail: string): void {
    repo.write('plugins/teamrig/package.json', JSON.stringify({ type: 'module' }));
    repo.write('plugins/teamrig/hooks/hooks.json', MANIFEST);
    repo.write('plugins/teamrig/hook.mjs', HOOK);
    repo.write('plugins/teamrig/dist/cli/main.js', main(fail));
    for (const launcher of LAUNCHERS) {
      repo.write(launcher, readFileSync(join(REPO_ROOT, ...launcher.split('/')), 'utf8'));
    }
    chmodSync(join(repo.dir, ...POSIX_LAUNCHER.split('/')), 0o755);
    repo.git('add', '-A');
    repo.git('update-index', '--chmod=+x', POSIX_LAUNCHER);
    repo.git('commit', '-q', '-m', 'plugin');
  }

  it('clones the committed tree, runs every step from the PATH in a new team, then its hook', () => {
    commitPlugin('none');
    const result = repo.run(CLI);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^ {2}exit 0 git clone, no login$/m);
    assert.match(result.stdout, /^ {2}exit 0 inbox read$/m);
    assert.match(result.stdout, /^ {2}exit 0 SessionStart hook \(hook session-start\)$/m);
    assert.match(result.stdout, new RegExp(`^fresh-install: a new team runs from a fresh clone on ${process.platform}\\n$`, 'm'));
  });

  it('names the step that failed and exits 1', () => {
    commitPlugin('list');
    const result = repo.run(CLI);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^ {2}exit 1 list$/m);
    assert.match(result.stdout, new RegExp(`^fresh-install: 1 problem\\(s\\) on ${process.platform}:\\n {2}list: exit 1: list failed in team demo$`, 'm'));
  });
});
