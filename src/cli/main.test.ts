import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_VERSION } from '../core/version.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

/** The real process: argv, stdio, exit code and git, with the kit home in an empty temp folder. */
function cli(args: readonly string[], input = ''): { readonly status: number | null; readonly stdout: string } {
  const home = mkdtempSync(join(tmpdir(), 'teamrig-main-'));
  try {
    const result = spawnSync(process.execPath, [MAIN, ...args], {
      input,
      encoding: 'utf8',
      // A fixed team keeps the run off any team pointer above the temp folder on the test machine.
      env: { ...process.env, TEAMRIG_HOME: home, TEAMRIG_TEAM: 'app' },
      cwd: home,
    });
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('main', () => {
  it('prints the usage and the version with exit 0', () => {
    const help = cli(['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^teamrig <command>/);
    assert.deepEqual(cli(['--version']), { status: 0, stdout: `teamrig ${KIT_VERSION}\n` });
  });

  it('exits 64 on a line it cannot read', () => {
    assert.equal(cli(['no-such-command']).status, 64);
  });

  it('runs the push guard on hook JSON from stdin', () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
    const result = cli(['hook', 'push-guard'], payload);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"permissionDecision":"deny"/);
  });
});
