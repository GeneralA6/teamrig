import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePluginList, type PluginListFixture } from '../testing/plugin-list.ts';
import { INBOX_ADD_LAUNCHER_SCRIPT, inboxAddLauncherPath } from './host-launcher.ts';

/** A stand-in CLI that prints the words it was given, the team it was told, and exits 3 on `--to zulu`. */
const ECHO_CLI =
  "const argv = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({ argv, team: process.env.TEAMRIG_TEAM ?? null }));\nif (argv.includes('zulu')) { process.stderr.write('no session zulu\\n'); process.exit(3); }\n";

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the real launcher with Node in a temp folder holding a Claude Code config folder and the given plugins. */
function launch(fixture: PluginListFixture, args: readonly string[]): Run {
  const root = mkdtempSync(join(tmpdir(), 'teamrig-inbox-launcher-'));
  try {
    const config = writePluginList(root, fixture, ECHO_CLI);
    const launcher = inboxAddLauncherPath(join(root, 'kit'));
    mkdirSync(join(root, 'kit', 'bin'), { recursive: true });
    writeFileSync(launcher, INBOX_ADD_LAUNCHER_SCRIPT);
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: config };
    delete env['TEAMRIG_TEAM'];
    delete env['TEAMRIG_SESSION'];
    const result = spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', env, cwd: root });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LINE = ['--from', 'host:nightly-backup', '--to', 'alpha', '--text', 'backup failed'];

describe('inbox-add launcher (#930)', () => {
  it('lives in the kit home bin folder, beside the other launchers', () => {
    assert.equal(inboxAddLauncherPath(join('/', 'kit')), join('/', 'kit', 'bin', 'inbox-add.mjs'));
  });

  it("runs the installed CLI's inbox add with the job's words, and finds it again after an update moves it", () => {
    for (const installs of [['v2'], ['gone', 'v3']]) {
      const run = launch({ installs, empty: ['gone'], lookalike: true }, LINE);
      assert.deepEqual([run.status, JSON.parse(run.stdout)], [0, { argv: ['inbox', 'add', ...LINE], team: null }], installs.join());
    }
  });

  it('names the team by --team, which it hands on as $TEAMRIG_TEAM', () => {
    const run = launch({ installs: ['v2'] }, ['--team', 'app', ...LINE]);
    assert.deepEqual(JSON.parse(run.stdout), { argv: ['inbox', 'add', ...LINE], team: 'app' });
  });

  it('reads --team only as the first pair, so a --team word later in the line, such as the text, is passed on as is', () => {
    const words = ['--from', 'host:job', '--text', '--team', '--to', 'alpha'];
    const later = launch({ installs: ['v2'] }, words);
    assert.deepEqual(JSON.parse(later.stdout), { argv: ['inbox', 'add', ...words], team: null });
    const both = launch({ installs: ['v2'] }, ['--team', 'app', ...words]);
    assert.deepEqual(JSON.parse(both.stdout), { argv: ['inbox', 'add', ...words], team: 'app' });
  });

  it("exits with the CLI's refusal, and with 1 when no teamrig plugin is installed", () => {
    const refused = launch({ installs: ['v2'] }, ['--from', 'host:job', '--to', 'zulu', '--text', 'hi']);
    assert.deepEqual([refused.status, refused.stderr], [3, 'no session zulu\n']);
    for (const fixture of [{ noPluginList: true }, { lookalike: true }] satisfies PluginListFixture[]) {
      const missing = launch(fixture, LINE);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /^teamrig inbox-add: teamrig not found/);
    }
  });
});
