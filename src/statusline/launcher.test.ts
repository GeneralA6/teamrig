import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LAUNCHER_SCRIPT, launcherPath } from './launcher.ts';

const MAIN = fileURLToPath(new URL('../cli/main.ts', import.meta.url));
/** A stand-in CLI that prints the words and input it was given. */
const ECHO_CLI = "let input = ''; for await (const chunk of process.stdin) input += chunk;\nprocess.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input }));\n";

interface Fixture {
  /** The plugin folders to list under `teamrig@market`, in order; each one gets `cliText` unless it is in `empty`. */
  readonly installs?: readonly string[];
  readonly empty?: readonly string[];
  readonly cliText?: string;
  /** Another plugin whose name starts with the same word, listed first: it must not be taken for the kit. */
  readonly lookalike?: boolean;
  readonly noPluginList?: boolean;
}

/** Runs the real launcher with Node in a temp folder holding a Claude Code config folder and the given plugins. */
function launch(fixture: Fixture, args: readonly string[], input: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const root = mkdtempSync(join(tmpdir(), 'teamrig-launcher-'));
  try {
    const config = join(root, 'claude');
    const plugin = (name: string, text: string): string => {
      const folder = join(root, name);
      mkdirSync(join(folder, 'dist', 'cli'), { recursive: true });
      // Like the real plugin folder, so main.js is an ES module.
      writeFileSync(join(folder, 'package.json'), '{ "type": "module" }');
      writeFileSync(join(folder, 'dist', 'cli', 'main.js'), text);
      return folder;
    };
    const installs = (fixture.installs ?? []).map((name) =>
      fixture.empty?.includes(name) === true ? join(root, name) : plugin(name, fixture.cliText ?? ECHO_CLI),
    );
    const plugins: Record<string, unknown> = {};
    if (fixture.lookalike === true) {
      plugins['teamrig-pane@market'] = [{ installPath: plugin('pane', "process.stdout.write('pane');\n") }];
    }
    plugins['teamrig@market'] = installs.map((installPath) => ({ installPath }));
    if (fixture.noPluginList !== true) {
      mkdirSync(join(config, 'plugins'), { recursive: true });
      writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
    }
    const launcher = launcherPath(join(root, 'kit'));
    mkdirSync(join(root, 'kit', 'bin'), { recursive: true });
    writeFileSync(launcher, LAUNCHER_SCRIPT);
    const result = spawnSync(process.execPath, [launcher, ...args], {
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, TEAMRIG_HOME: join(root, 'kit'), TEAMRIG_TEAM: 'app' },
      cwd: root,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('statusline launcher', () => {
  it('lives in the kit home bin folder', () => {
    assert.equal(launcherPath(join('/', 'kit')), join('/', 'kit', 'bin', 'statusline.mjs'));
  });

  it("runs the first installed kit CLI that exists on the same input, with --pass when given", () => {
    const fixture: Fixture = { installs: ['gone', 'v2'], empty: ['gone'], lookalike: true };
    const plain = launch(fixture, [], '{"a":1}');
    assert.deepEqual([plain.status, JSON.parse(plain.stdout)], [0, { argv: ['statusline'], input: '{"a":1}' }]);
    const passing = launch(fixture, ['--pass'], '{"a":1}');
    assert.deepEqual(JSON.parse(passing.stdout), { argv: ['statusline', '--pass'], input: '{"a":1}' });
  });

  it('never breaks the status bar: no plugin list, no kit plugin or a failed run still exit 0', () => {
    for (const fixture of [{ noPluginList: true }, { lookalike: true }, { installs: ['v2'], cliText: 'process.exit(3);\n' }] satisfies Fixture[]) {
      const plain = launch(fixture, [], '{"a":1}');
      assert.equal(plain.status, 0);
      assert.match(plain.stdout, /^teamrig (not found|failed)\n$/);
      assert.match(plain.stderr, /teamrig statusline: teamrig (not found|failed)/);
      assert.deepEqual([launch(fixture, ['--pass'], '{"a":1}').stdout], ['{"a":1}']);
    }
  });

  it('with the real CLI and --pass, saves nothing it cannot read and passes the input on', () => {
    const viaMain = `await import(${JSON.stringify(pathToFileURL(MAIN).href)});\n`;
    const result = launch({ installs: ['v2'], cliText: viaMain }, ['--pass'], '{"model":{}}\n');
    assert.deepEqual([result.status, result.stdout], [0, '{"model":{}}\n']);
  });
});
