import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KIT_VERSION } from '../core/version.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

/** The longest one CLI run here may take: far over a run on a loaded machine, far under the coverage gate's silence limit. */
const CLI_TIMEOUT_MS = 120_000;

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
}

/** The real process run in a kit home: argv, stdio, exit code and git. */
function cliIn(home: string, args: readonly string[], input = ''): CliResult {
  const result = spawnSync(process.execPath, [MAIN, ...args], {
    input,
    encoding: 'utf8',
    // A fixed team keeps the run off any team pointer above the temp folder on the test machine.
    env: { ...process.env, TEAMRIG_HOME: home, TEAMRIG_TEAM: 'app' },
    cwd: home,
    // A run that waits (on the host lock, or on the host's memory) fails the test instead of holding the suite (#599).
    timeout: CLI_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout };
}

/** Runs the test with a kit home in an empty temp folder, removed after. */
function inTempHome<T>(use: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'teamrig-main-'));
  try {
    return use(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** One command in a fresh kit home. */
function cli(args: readonly string[], input = ''): CliResult {
  return inTempHome((home) => cliIn(home, args, input));
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

  it('runs a queued step under the host lock, releases it and ledgers the step under a fresh id', () => {
    inTempHome((home) => {
      assert.equal(cliIn(home, ['team', 'create', 'app', '--sessions', 'api', '--project', home]).status, 0);
      // The step passes the memory gate on any machine: no floor or reserve on free memory, and a commit charge up to
      // the limit, so the test does not wait on the memory of the host it runs on (#599).
      const configPath = join(home, 'teams', 'app', 'config.json');
      const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
      assert.ok(typeof config === 'object' && config !== null);
      const roomy = {
        ...config,
        delivery: { queue: { memoryFloorMb: 0, smallReserveMb: 0, heavyReserveMb: 0 } },
        open: { headroom: { commitMaxPct: 100 } },
      };
      writeFileSync(configPath, `${JSON.stringify(roomy, null, 2)}\n`);
      const run = cliIn(home, ['queue', '--session', 'api', '--what', 'probe', '--', process.execPath, '-e', 'process.exit(0)']);
      assert.equal(run.status, 0);
      assert.match(run.stdout, /running: probe \(killed after 45m\)\nDONE exit 0\n$/);
      assert.equal(existsSync(join(home, 'host.lock')), false, 'the lock is released');
      const ledger = readFileSync(join(home, 'teams', 'app', 'state', 'deploys', 'ledger.jsonl'), 'utf8');
      const ids = [...ledger.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1]);
      assert.equal(ids.length, 2, 'a start and an end record');
      assert.equal(ids[0], ids[1]);
      assert.match(ids[0] ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });
});
