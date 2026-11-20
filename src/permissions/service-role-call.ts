import type { ShellCall } from '../ports/host/index.ts';
import { parseIssueTarget, targetText } from '../issues/host.ts';
import { readable } from '../slash/plan.ts';
import type { ParsedArgs } from '../cli/args.ts';
import { ABSOLUTE, matchesKit, type KitShape } from './route-kit.ts';
import { plainWordsOf } from './route-line.ts';
import { isIssueCommand, MIGRATE_COMMAND, type IssueCommand, type MigrateCommand, type ShipCommand } from './service-commands.ts';
import { shipCallOf, type ShipCallContext, type ShipRun } from './ship-role-call.ts';

/**
 * The call shapes a service role lets run (T2984, design 1): each table command as the CLI's own parser reads it, with
 * typed slots and no wildcard. `teamrig issue close <owner/name#n> [--comment "<text>"]`, through this install's own launcher, on a
 * repository of `github.repos`, as one plain command. The route gate (route-line.ts) refuses `#` and every joining character even inside quotes, which an issue
 * target and a comment need, so this reader masks exactly those parts first, after proving them literal to bash: the
 * target word as `owner/name#n` (a `#` inside a word starts no comment), and each double-quoted text holding no `"`,
 * `\`, `$`, backtick or control character (bash expands nothing in it). A line with a single quote or a backslash
 * outside such a text is no role call: the mask could not tell where bash's quotes end. A queued ship or merge is read
 * in the ship tool's own shape (ship-role-call.ts), through the same mask. `teamrig issue migrate <rows file> --yes`
 * names its file by an absolute path, which the allow holds to the team's task files (migrate-role-check.ts).
 */

/** The shape of each issue command; a new table entry adds its shape here, with a security review. */
const SHAPES: Readonly<Record<IssueCommand, KitShape>> = {
  'issue close': { commands: ['issue close'], options: ['session', 'comment'], positionals: 'one' },
};

/**
 * `issue migrate`'s shape (T4606): the rows file and `--yes`, the run that opens the issues; never `--out`, which
 * writes a preview at any path the line names.
 */
const MIGRATE_SHAPE: KitShape = { commands: [MIGRATE_COMMAND], options: ['session', 'yes'], positionals: 'one' };

/** A double-quoted text bash takes as it reads: nothing it expands, escapes or ends. */
const LITERAL_TEXT = /^[^"\\$`\p{Cc}]*$/u;

/** An issue target as a word of its own, its `#` the one the mask hides. */
const TARGET_WORD = /(?<=^|[ \t])([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})(?=[ \t]|$)/g;

/**
 * The line as the route gate's raw scan should read it for a role call: each literal double-quoted text as `"t"`, each
 * issue target's `#` as `_`; undefined when a quote or backslash outside such a text, or a quote that never closes,
 * leaves bash's reading of the line unclear.
 */
export function roleScanTextOf(line: string): string | undefined {
  let scanned = '';
  for (let at = 0; at < line.length; at++) {
    const character = line.charAt(at);
    if (character === '\\' || character === "'") {
      return undefined;
    }
    if (character !== '"') {
      scanned += character;
      continue;
    }
    const end = line.indexOf('"', at + 1);
    if (end < 0 || !LITERAL_TEXT.test(line.slice(at + 1, end))) {
      return undefined;
    }
    scanned += '"t"';
    at = end;
  }
  return scanned.replace(TARGET_WORD, '$1_$2');
}

/** An issue command's call: the issue, and the `--session` the line names. */
export interface IssueRoleCall {
  readonly command: IssueCommand;
  /** `owner/name#n`, as the command takes it, lowercased. */
  readonly target: string;
  /**
   * The `--session` flag's text, which every role call names (T2984): the CLI would otherwise take the caller from
   * the shell's environment, which a profile can change, and the hook from its own, so the two could differ.
   */
  readonly session: string;
}

/** A migrate's call: its rows file, and the `--session` the line names (as above). */
export interface MigrateRoleCall {
  readonly command: MigrateCommand;
  /** The rows file, an absolute path as the line names it; the allow holds it to the team's task files. */
  readonly target: string;
  readonly session: string;
}

/** A queued ship or merge: what the tool runs on, for the allow to check, and the queue's `--session` (N1, as above). */
export interface ShipRoleCall {
  readonly command: ShipCommand;
  /** The worktree, as the line names it; the allow logs its branch instead. */
  readonly target: string;
  readonly session: string;
  readonly ship: ShipRun;
}

/** What a role call runs: the table command, its target, and the session the line names. */
export type RoleCall = IssueRoleCall | MigrateRoleCall | ShipRoleCall;

/** The flags whose text a role call posts on GitHub. */
const POSTED_FLAGS: readonly string[] = ['comment', 'body'];

/**
 * Text a role call does not post unasked (T2984): a format or bidi character (`U+202E`, a zero-width space), a line
 * or paragraph separator, which can make a post read other than it is, or an @-mention, which pings someone outside
 * the team. The post still runs once the permission check lets it.
 */
const UNPOSTABLE = /[\p{Cf}\p{Zl}\p{Zp}]|(?<![\p{L}\p{N}_])@[\p{L}\p{N}]/u;

/**
 * What a role call needs beyond the line: the CLI's table, its own launcher, the team's GitHub repositories, and
 * whether a word names the team's ship tool.
 */
export interface RoleCallContext extends ShipCallContext {
  readonly repos: readonly string[];
}

/** The role call `line` is, when it is one plain command of a table shape on a team repository; else undefined. */
export async function roleCallOf(line: string, context: RoleCallContext): Promise<RoleCall | undefined> {
  const scanned = roleScanTextOf(line);
  const words = scanned === undefined ? undefined : plainWordsOf(line, scanned);
  const parsed = words === undefined ? undefined : readable(words.slice(1), context.cli);
  const [program] = words ?? [];
  if (program !== undefined && parsed?.command === 'queue') {
    const ship = await shipCallOf(program, parsed, context);
    const session = parsed.flags.get('session');
    return ship === undefined || session === undefined ? undefined : { command: ship.merges ? 'queue merge' : 'queue ship', target: ship.worktree, session, ship };
  }
  if (words !== undefined && parsed?.command === MIGRATE_COMMAND) {
    return migrateCallOf(words, parsed, context);
  }
  if (words === undefined || parsed === undefined || !isIssueCommand(parsed.command)) {
    return undefined;
  }
  const command = parsed.command;
  const target = parseIssueTarget(parsed.positionals[0] ?? '');
  const session = parsed.flags.get('session');
  const posts = POSTED_FLAGS.map((flag) => parsed.flags.get(flag) ?? '');
  if (target === undefined || session === undefined || posts.some((text) => UNPOSTABLE.test(text))) {
    return undefined;
  }
  if (!context.repos.includes(target.repo) || !(await matchesKit(SHAPES[command], words, context))) {
    return undefined;
  }
  return { command, target: targetText(target), session };
}

/** The migrate `words` run, when it opens the issues (`--yes`) from a rows file named by an absolute path; else undefined. */
async function migrateCallOf(words: readonly string[], parsed: ParsedArgs, context: RoleCallContext): Promise<MigrateRoleCall | undefined> {
  const [file] = parsed.positionals;
  const session = parsed.flags.get('session');
  if (file === undefined || !ABSOLUTE.test(file) || session === undefined || !parsed.switches.has('yes')) {
    return undefined;
  }
  return (await matchesKit(MIGRATE_SHAPE, words, context)) ? { command: MIGRATE_COMMAND, target: file, session } : undefined;
}

/**
 * The role call a bash call runs; undefined for any other shell or line. A call only when its shell may run one text
 * (the call's `readings`): a second reading comes only from a backslash run, which no role call holds.
 */
export async function shellRoleCallOf(call: ShellCall, context: RoleCallContext): Promise<RoleCall | undefined> {
  const [only] = call.readings;
  return call.dialect !== 'bash' || call.readings.length !== 1 || only === undefined ? undefined : roleCallOf(only, context);
}
