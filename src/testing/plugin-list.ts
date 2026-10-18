import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The plugins a launcher test's Claude Code config folder lists as installed. */
export interface PluginListFixture {
  /** The plugin folders to list under `teamrig@market`, in order; each one gets `cliText` unless it is in `empty`. */
  readonly installs?: readonly string[];
  readonly empty?: readonly string[];
  readonly cliText?: string;
  /** Another plugin whose name starts with the same word, listed first: it must not be taken for the kit. */
  readonly lookalike?: boolean;
  readonly noPluginList?: boolean;
}

/**
 * Writes, under `root`, a Claude Code config folder whose plugin list holds the fixture's plugins, each with a
 * `dist/cli/main.js` of `cliText` (else `defaultCli`); returns the config folder for CLAUDE_CONFIG_DIR.
 */
export function writePluginList(root: string, fixture: PluginListFixture, defaultCli: string): string {
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
    fixture.empty?.includes(name) === true ? join(root, name) : plugin(name, fixture.cliText ?? defaultCli),
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
  return config;
}
