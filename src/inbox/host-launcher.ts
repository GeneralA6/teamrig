import { join } from 'node:path';
import { FIND_TEAMRIG_CLI } from '../core/launcher-script.ts';

/** The launcher's place under the kit home: `<kit home>/bin/inbox-add.mjs`. */
export function inboxAddLauncherPath(kitHome: string): string {
  return join(kitHome, 'bin', 'inbox-add.mjs');
}

/**
 * The launcher a host scheduled job runs to add an inbox line (#930): a cron, launchd or Task Scheduler entry names
 * this file because it never moves, while the plugin folder changes with every plugin version. On each run it finds
 * the installed plugin's CLI (FIND_TEAMRIG_CLI) and runs `teamrig inbox add` with the job's words, so the line meets
 * the same rules and refusals (`--from host:<job>`: sessions of the team by id or name, no wake). `--team <team>`,
 * read only as the first pair, names the team when the job does not run in its project folder, handed on as
 * $TEAMRIG_TEAM. It exits with the CLI's
 * code, and 1 when no teamrig plugin is installed, so the job's own log shows a line that did not land. A session
 * start writes it and keeps it up to date (src/restore/launcher-refresh.ts); the text carries no kit version, so a
 * plugin update leaves it alone unless its own logic changed.
 */
export const INBOX_ADD_LAUNCHER_SCRIPT = String.raw`// Written by teamrig at a session start, and kept up to date with each plugin version.
// A host scheduled job adds an inbox line with it, through the installed teamrig plugin's "teamrig inbox add":
//   node <this file> [--team <team>] --from host:<job> --to <session> --text "<one line>"
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

${FIND_TEAMRIG_CLI}

const words = process.argv.slice(2);
const env = { ...process.env };
// Only as the first pair, so a "--team" later in the line (a --text word) reaches inbox add as it is.
if (words[0] === '--team' && words.length > 1) {
  env.TEAMRIG_TEAM = words[1];
  words.splice(0, 2);
}
const main = teamrigCli();
if (main === undefined) {
  process.stderr.write("teamrig inbox-add: teamrig not found: no teamrig plugin in Claude Code's plugin list\n");
  process.exit(1);
}
const run = spawnSync(process.execPath, [main, 'inbox', 'add', ...words], { env, stdio: 'inherit', windowsHide: true });
process.exit(run.status ?? 1);
`;
