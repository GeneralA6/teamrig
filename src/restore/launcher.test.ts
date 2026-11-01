import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePluginList, type PluginListFixture } from '../testing/plugin-list.ts';
import {
  RESTORE_CHECK_LAUNCHER_SCRIPT,
  RESTORE_RUN_LAUNCHER_SCRIPT,
  restoreCheckLauncherPath,
  restoreRunLauncherPath,
  RUN_LAUNCHER_HOLD_SECONDS,
} from './launcher.ts';

/** A stand-in CLI that writes the words it was given to the file ARGV_OUT names. */
const RECORDING_CLI = "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n";

/** A launcher the kit writes: where it goes in a kit home, and its text. */
interface LauncherKind {
  readonly pathOf: (kitHome: string) => string;
  readonly script: string;
}

const CHECK: LauncherKind = { pathOf: restoreCheckLauncherPath, script: RESTORE_CHECK_LAUNCHER_SCRIPT };
const RUN: LauncherKind = { pathOf: restoreRunLauncherPath, script: RESTORE_RUN_LAUNCHER_SCRIPT };

interface Launch {
  readonly status: number | null;
  readonly kitHome: string;
  /** The words the CLI was run with; undefined when it never ran. */
  readonly argv: readonly string[] | undefined;
  /** The restore log after the launch; undefined when there is none. */
  readonly log: string | undefined;
  readonly stdout: string;
}

/** A kit home in a fresh folder holding the launcher, with a Claude Code config listing the given plugins. */
interface Scene {
  readonly root: string;
  readonly kitHome: string;
  readonly launcher: string;
  readonly env: NodeJS.ProcessEnv;
}

function scene(kind: LauncherKind, fixture: PluginListFixture): Scene {
  const root = mkdtempSync(join(tmpdir(), 'teamrig-restore-launcher-'));
  const config = writePluginList(root, fixture, RECORDING_CLI);
  const kitHome = join(root, 'my kit');
  const launcher = kind.pathOf(kitHome);
  mkdirSync(join(kitHome, 'bin'), { recursive: true });
  writeFileSync(launcher, kind.script);
  return { root, kitHome, launcher, env: { ...process.env, CLAUDE_CONFIG_DIR: config, ARGV_OUT: join(root, 'argv.json') } };
}

function logOf(kitHome: string): string | undefined {
  const logPath = join(kitHome, 'restore', 'restore.log');
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : undefined;
}

/** The lines `child` prints up to and with `last`; rejects when it ends before printing it. */
async function linesUntil(child: ChildProcess, last: string): Promise<string[]> {
  let printed = '';
  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      printed += chunk.toString('utf8');
      const lines = printed.split(/\r?\n/);
      if (lines.includes(last)) {
        resolve(lines.slice(0, lines.indexOf(last) + 1));
      }
    });
    child.on('exit', (code) => reject(new Error(`ended with ${code} before printing "${last}"; printed: ${printed}`)));
  });
}

/** The words RECORDING_CLI wrote to `path`; undefined when it never ran. */
function wordsIn(path: string): string[] | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(Array.isArray(parsed) && parsed.every((word): word is string => typeof word === 'string'), 'the CLI wrote a list of words');
  return parsed;
}

/** Runs the real launcher from a kit home's bin folder, as a logon or the shortcut does, to its end. */
function launch(kind: LauncherKind, fixture: PluginListFixture): Launch {
  const { root, kitHome, launcher, env } = scene(kind, fixture);
  try {
    const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8', env, cwd: root });
    return { status: result.status, kitHome, argv: wordsIn(join(root, 'argv.json')), log: logOf(kitHome), stdout: result.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function logon(fixture: PluginListFixture): Launch {
  return launch(CHECK, fixture);
}

describe('restore run launcher', () => {
  it('lives in the kit home bin folder, beside the check launcher', () => {
    assert.equal(restoreRunLauncherPath(join('/', 'kit')), join('/', 'kit', 'bin', 'restore-run.mjs'));
  });

  it('runs restore run --tab of the first installed kit CLI on the kit home it sits in, in its own window, and passes its exit on', () => {
    const cliText = `${RECORDING_CLI}console.log('Restoring 2 Claude Code sessions');\nprocess.exit(4);\n`;
    const run = launch(RUN, { installs: ['gone', 'v2'], empty: ['gone'], lookalike: true, cliText });
    assert.deepEqual([run.status, run.argv, run.stdout.trim(), run.log], [4, ['restore', 'run', '--tab', '--home', run.kitHome], 'Restoring 2 Claude Code sessions', undefined]);
  });

  it('says why when teamrig is not found, logs it, and keeps its window open to be read', { timeout: 30_000 }, async () => {
    const { root, kitHome, launcher, env } = scene(RUN, { lookalike: true });
    const child = spawn(process.execPath, [launcher], { env, cwd: root });
    try {
      const closes = `This window closes in ${RUN_LAUNCHER_HOLD_SECONDS} s.`;
      assert.deepEqual(await linesUntil(child, closes), ['FAILED: teamrig not found in the Claude Code plugin list', closes]);
      assert.equal(child.exitCode, null, 'the window is still open');
      assert.match(logOf(kitHome) ?? '', /^\d{4}-\d\d-\d\dT[\d:.]+Z shortcut: teamrig not found in the Claude Code plugin list\n$/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        child.kill();
        await ended;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('restore check launcher', () => {
  it('lives in the kit home bin folder', () => {
    assert.equal(restoreCheckLauncherPath(join('/', 'kit')), join('/', 'kit', 'bin', 'restore-check.mjs'));
  });

  it('runs restore check of the first installed kit CLI that exists, on the kit home it sits in, and logs nothing', () => {
    const run = logon({ installs: ['gone', 'v2'], empty: ['gone'], lookalike: true });
    assert.equal(run.status, 0);
    assert.deepEqual(run.argv, ['restore', 'check', '--home', run.kitHome]);
    assert.equal(run.log, undefined);
  });

  it('logs that teamrig was not found when no plugin list or kit plugin is there', () => {
    for (const fixture of [{ noPluginList: true }, { lookalike: true }] satisfies PluginListFixture[]) {
      const run = logon(fixture);
      assert.deepEqual([run.status, run.argv], [0, undefined]);
      assert.match(run.log ?? '', /^\d{4}-\d\d-\d\dT[\d:.]+Z logon: teamrig not found in the Claude Code plugin list\n$/);
    }
  });

  it('logs the exit and every line the check printed when it does not exit 0', () => {
    const cliText = "console.log('MANUAL no terminal opened (no wt.exe); open a new terminal and run this:');\nconsole.log('  node main.js restore run');\nconsole.error('WARN a team config did not load');\nprocess.exit(3);\n";
    const run = logon({ installs: ['v2'], cliText });
    assert.equal(run.status, 0);
    assert.match(
      run.log ?? '',
      / logon: teamrig restore check exited 3: MANUAL no terminal opened \(no wt\.exe\); open a new terminal and run this: \| node main\.js restore run \| WARN a team config did not load\n$/,
    );
  });

  it('logs the exit alone when the check printed nothing', () => {
    const run = logon({ installs: ['v2'], cliText: 'process.exit(1);\n' });
    assert.match(run.log ?? '', / logon: teamrig restore check exited 1\n$/);
  });
});
