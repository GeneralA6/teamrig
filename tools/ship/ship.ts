import { leftoversCommand } from './leftovers.ts';
import { checkCommand } from './local-gate.ts';
import { mergeCommand } from './merge.ts';
import { shipCommand } from './ship-command.ts';
import { realShipDeps } from './ship-deps.ts';

/**
 * The ship tool's command line; what each command does lives in its module.
 * Ships a finished teamrig change from a tested working tree (ship-commits.ts):
 *   node ship.ts <teamrig dir> <plan.json> [base, default origin/main] [--merge [--approved <sha>] [--note-file <path>]]
 * plan.json: { "chunks": [ { "files": ["src/a.ts", ...], "subject": "area: what", "body": "why" } ] }
 *
 * Proves a repo dir's checked-out tree with its local checks (a pass record, else a run that writes one):
 *   node ship.ts check <repo dir>
 * And merges a pushed change branch into main (merge.ts: PR, its head proven by the repo's gate, rebase):
 *   node ship.ts merge <repo dir> [--head <branch>, default the checked-out one] [--timeout-min 45] [--interval-s 30]
 * And deletes the heads of closed, unmerged pull requests on origin, then lists the other branches against main (leftovers.ts):
 *   node ship.ts leftovers <repo dir>
 * This file only dispatches to those commands, a ship with the real deps of ship-deps.ts; ship.test.ts runs it as its
 * own process.
 */

const argv = process.argv.slice(2);
if (argv[0] === 'merge') process.exitCode = await mergeCommand(argv.slice(1));
else if (argv[0] === 'check') process.exitCode = checkCommand(argv.slice(1));
else if (argv[0] === 'leftovers') process.exitCode = leftoversCommand(argv.slice(1));
else process.exitCode = await shipCommand(argv, realShipDeps, (line) => console.error(line));
