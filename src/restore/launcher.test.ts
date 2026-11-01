import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePluginList, type PluginListFixture } from '../testing/plugin-list.ts';
import { RESTORE_CHECK_LAUNCHER_SCRIPT, restoreCheckLauncherPath } from './launcher.ts';

/** A stand-in CLI that writes the words it was given to the file ARGV_OUT names. */
const RECORDING_CLI = "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n";

interface Logon {
  readonly status: number | null;
  readonly kitHome: string;
  /** The words the CLI was run with; undefined when it never ran. */
  readonly argv: readonly string[] | undefined;
  /** The restore log after the logon; undefined when there is none. */
  readonly log: string | undefined;
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

/** Runs the real launcher from a kit home's bin folder, as a logon does, with a Claude Code config listing the given plugins. */
function logon(fixture: PluginListFixture): Logon {
  const root = mkdtempSync(join(tmpdir(), 'teamrig-restore-launcher-'));
  try {
    const config = writePluginList(root, fixture, RECORDING_CLI);
    const kitHome = join(root, 'my kit');
    const launcher = restoreCheckLauncherPath(kitHome);
    mkdirSync(join(kitHome, 'bin'), { recursive: true });
    writeFileSync(launcher, RESTORE_CHECK_LAUNCHER_SCRIPT);
    const argvOut = join(root, 'argv.json');
    const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: config, ARGV_OUT: argvOut }, cwd: root });
    const logPath = join(kitHome, 'restore', 'restore.log');
    return {
      status: result.status,
      kitHome,
      argv: wordsIn(argvOut),
      log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('restore launcher', () => {
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
