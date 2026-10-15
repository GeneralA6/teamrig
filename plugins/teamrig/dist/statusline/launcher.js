import { join } from 'node:path';
/** The launcher's place under the kit home: `<kit home>/bin/statusline.mjs`. */
export function launcherPath(kitHome) {
    return join(kitHome, 'bin', 'statusline.mjs');
}
/**
 * The launcher `teamrig statusline install` writes. Claude Code's settings name this file because it never
 * moves, while the plugin folder changes with every plugin version. On each run it finds the installed
 * plugin's CLI through Claude Code's plugin list and runs `teamrig statusline` (with `--pass` when given)
 * on the same input. It always exits 0, so a missing plugin or a failed run never breaks the status bar;
 * with `--pass` it then passes the input on itself, so the status line after it still runs. The text
 * carries no kit version: it changes only when its own logic does, so a plugin update leaves it alone.
 */
export const LAUNCHER_SCRIPT = String.raw `// Written by "teamrig statusline install"; "teamrig statusline uninstall" removes it.
// Runs the installed teamrig plugin's "teamrig statusline" on Claude Code's status input.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const pass = process.argv.includes('--pass');
let input = '';
try {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
} catch {}

function teamrigCli() {
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
}

const main = teamrigCli();
const run = main === undefined
  ? undefined
  : spawnSync(process.execPath, [main, 'statusline', ...(pass ? ['--pass'] : [])], { input, encoding: 'utf8' });
if (run?.stderr) process.stderr.write(run.stderr);
if (run !== undefined && run.status === 0) {
  process.stdout.write(run.stdout);
} else {
  const problem = main === undefined ? 'teamrig not found' : 'teamrig failed';
  process.stderr.write('teamrig statusline: ' + problem + '\n');
  process.stdout.write(pass ? input : problem + '\n');
}
`;
