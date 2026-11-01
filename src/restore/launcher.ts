import { join } from 'node:path';
import { FIND_TEAMRIG_CLI } from '../core/launcher-script.ts';

/** The check launcher's place under the kit home: `<kit home>/bin/restore-check.mjs`. */
export function restoreCheckLauncherPath(kitHome: string): string {
  return join(kitHome, 'bin', 'restore-check.mjs');
}

/**
 * The check launcher `teamrig restore install` writes and the system runs at each logon. The logon entry names this file
 * because it never moves, while the plugin folder changes with every plugin version. It finds the installed
 * plugin's CLI (FIND_TEAMRIG_CLI) and runs `teamrig restore check` on the kit home it sits in, the folder above
 * its bin folder, which a logon's environment may not name. No one sees a logon's output, so when the plugin is
 * not found, the check does not start or it ends with an exit other than 0, the launcher adds why, with what the
 * check printed, to the restore log. The text carries no kit version, so a plugin update leaves it alone.
 */
export const RESTORE_CHECK_LAUNCHER_SCRIPT = String.raw`// Written by "teamrig restore install"; "teamrig restore uninstall" removes it.
// Run at each logon: runs the installed teamrig plugin's "teamrig restore check" on the kit home this file is in.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

${FIND_TEAMRIG_CLI}

const kitHome = dirname(dirname(fileURLToPath(import.meta.url)));
const main = teamrigCli();
const run = main === undefined
  ? undefined
  : spawnSync(process.execPath, [main, 'restore', 'check', '--home', kitHome], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
let problem;
if (run === undefined) {
  problem = 'teamrig not found in the Claude Code plugin list';
} else if (run.error !== undefined) {
  problem = 'teamrig restore check did not start: ' + run.error.message;
} else if (run.status !== 0) {
  const said = (run.stdout + '\n' + run.stderr).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').join(' | ');
  problem = 'teamrig restore check exited ' + (run.status ?? 'on ' + run.signal) + (said === '' ? '' : ': ' + said);
}
if (problem !== undefined) {
  try {
    mkdirSync(join(kitHome, 'restore'), { recursive: true });
    appendFileSync(join(kitHome, 'restore', 'restore.log'), new Date().toISOString() + ' logon: ' + problem + '\n');
  } catch {}
}
`;
