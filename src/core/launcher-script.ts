/**
 * The source of `teamrigCli()`, shared by the launchers teamrig writes to the kit home's bin folder. A launcher
 * never names the plugin folder, which changes with every plugin version: on each run this finds the installed
 * plugin's CLI through Claude Code's plugin list. It returns the path of the first install's `dist/cli/main.js`
 * that exists, or undefined. A launcher that holds it imports `existsSync` and `readFileSync` from `node:fs`,
 * `homedir` from `node:os` and `join` from `node:path`.
 */
export const FIND_TEAMRIG_CLI = String.raw`function teamrigCli() {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  let list;
  try {
    list = JSON.parse(readFileSync(join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return undefined;
  }
  for (const [key, installs] of Object.entries(list?.plugins ?? {})) {
    if (!key.startsWith('teamrig@') || !Array.isArray(installs)) continue;
    for (const install of installs) {
      if (typeof install?.installPath !== 'string') continue;
      const main = join(install.installPath, 'dist', 'cli', 'main.js');
      if (existsSync(main)) return main;
    }
  }
  return undefined;
}`;
