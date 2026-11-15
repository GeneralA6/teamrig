import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../core/guards.ts';
import { KIT_VERSION } from '../core/version.ts';

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url));

/** The line a queued step prints when it waits: on the host lock, or on the host's memory, which says so after it. */
const WAITING_LINE = /^.* waiting (?:for the host lock|to share the host).*$/mu;

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
}

interface QueueResult extends CliResult {
  /** The line the step printed when it began to wait, when it did: the run was killed there. */
  readonly waited: string | undefined;
}

/** A fixed team keeps a run off any team pointer above the temp folder on the test machine. */
function envIn(home: string): NodeJS.ProcessEnv {
  return { ...process.env, TEAMRIG_HOME: home, TEAMRIG_TEAM: 'app' };
}

/** The real process run in a kit home: argv, stdio, exit code and git. Only `queue` waits, so only `queueIn` bounds a run. */
function cliIn(home: string, args: readonly string[], input = ''): CliResult {
  const result = spawnSync(process.execPath, [MAIN, ...args], { input, encoding: 'utf8', env: envIn(home), cwd: home });
  return { status: result.status, stdout: result.stdout };
}

/**
 * `teamrig queue` as a real process, however long the host takes to run it (T2820). Its process and memory probes start
 * PowerShell on Windows: one passing run took 48 s in a busy merge gate, and a busier one passed a 120 s bound. So no
 * clock bounds it. A run that waits, on the host lock or on the host's memory, is killed at its first waiting line, and
 * the test fails on that line instead of holding the suite (#599).
 */
function queueIn(home: string, args: readonly string[]): Promise<QueueResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, 'queue', ...args], { env: envIn(home), cwd: home, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    let waited: string | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      const line = WAITING_LINE.exec(stdout);
      if (waited === undefined && line !== null) {
        waited = line[0];
        child.kill();
      }
    });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, waited }));
  });
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

/** `inTempHome` for a test that awaits: the folder is removed once its run ends. */
async function inTempHomeAsync(use: (home: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'teamrig-main-'));
  try {
    await use(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Lets the team's queued steps start whatever the host's memory: the default floor waits for 4 GB, which a 7 GB
 * runner (GitHub's macOS one) rarely has free, and a busy host's commit charge can sit past the default 92% of its
 * limit (#599); either way the step would wait out the whole hour.
 */
function withoutMemoryWait(home: string, team: string): void {
  const path = join(home, 'teams', team, 'config.json');
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(isRecord(config), 'team create writes a config object');
  const queue = { memoryFloorMb: 0, smallReserveMb: 0, heavyReserveMb: 0 };
  writeFileSync(path, JSON.stringify({ ...config, delivery: { queue }, open: { headroom: { commitMaxPct: 100 } } }, null, 2));
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

  it('runs a queued step under the host lock, releases it and ledgers the step under a fresh id', async () => {
    await inTempHomeAsync(async (home) => {
      assert.equal(cliIn(home, ['team', 'create', 'app', '--sessions', 'api', '--project', home]).status, 0);
      withoutMemoryWait(home, 'app');
      const run = await queueIn(home, ['--session', 'api', '--what', 'probe', '--', process.execPath, '-e', 'process.exit(0)']);
      assert.equal(run.waited, undefined, 'the step waited instead of running');
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

  it('stops a queued step at its first waiting line, so a step that waits fails the suite at once instead of holding it (T2820)', async () => {
    await inTempHomeAsync(async (home) => {
      assert.equal(cliIn(home, ['team', 'create', 'app', '--sessions', 'api', '--project', home]).status, 0);
      withoutMemoryWait(home, 'app');
      // This test's own process holds the host lock, alive for the whole run, so a merge, which needs the whole host, waits.
      const now = Date.now();
      const held = { id: 'held-by-the-test', pid: process.pid, session: 'other', purpose: 'holds the host', acquiredAt: new Date(now).toISOString(), expiresAt: new Date(now + 3_600_000).toISOString() };
      writeFileSync(join(home, 'host.lock'), JSON.stringify(held));
      const run = await queueIn(home, ['--session', 'api', '--kind', 'merge', '--what', 'probe', '--', process.execPath, '-e', 'process.exit(0)']);
      assert.match(run.waited ?? '', / waiting for the host lock: other \(holds the host\)/u);
      assert.notEqual(run.status, 0, 'the step was stopped, not run');
      assert.doesNotMatch(run.stdout, /DONE exit 0/u);
    });
  });
});
