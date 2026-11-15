import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import { parseIssueTarget, targetText } from '../issues/host.ts';
import { readable } from '../slash/plan.ts';
import { matchesKit, type KitContext, type KitShape } from './route-kit.ts';
import { plainWordsOf } from './route-line.ts';
import { isServiceCommand, type ServiceCommand } from './service-commands.ts';

/**
 * The call shapes a service role lets run (T2984, design 1): each table command as the CLI's own parser reads it, with
 * typed slots and no wildcard. `teamrig issue close <owner/name#n> [--comment "<text>"]` and `teamrig issue comment
 * <owner/name#n> --body "<text>"`, through this install's own launcher, on a repository of `github.repos`, as one plain
 * command. The route gate (route-line.ts) refuses `#` and every joining character even inside quotes, which an issue
 * target and a comment need, so this reader masks exactly those parts first, after proving them literal to bash: the
 * target word as `owner/name#n` (a `#` inside a word starts no comment), and each double-quoted text holding no `"`,
 * `\`, `$`, backtick or control character (bash expands nothing in it). A line with a single quote or a backslash
 * outside such a text is no role call: the mask could not tell where bash's quotes end.
 */

/** The shape of each table command; a new table entry adds its shape here, with a security review. */
const SHAPES: Readonly<Record<ServiceCommand, KitShape>> = {
  'issue close': { commands: ['issue close'], options: ['session', 'comment'], positionals: 'one' },
  'issue comment': { commands: ['issue comment'], options: ['session', 'body'], positionals: 'one' },
};

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

/** What a role call runs: the table command, its target, and the `--session` it names. */
export interface RoleCall {
  readonly command: ServiceCommand;
  /** `owner/name#n`, as the command takes it, lowercased. */
  readonly target: string;
  /**
   * The `--session` flag's text, which every role call names (T2984): the CLI would otherwise take the caller from
   * the shell's environment, which a profile can change, and the hook from its own, so the two could differ.
   */
  readonly session: string;
}

/** What a role call needs beyond the line: the CLI's table, its own launcher, and the team's GitHub repositories. */
export interface RoleCallContext extends KitContext {
  readonly repos: readonly string[];
}

/** The role call `line` is, when it is one plain command of a table shape on a team repository; else undefined. */
export async function roleCallOf(line: string, context: RoleCallContext): Promise<RoleCall | undefined> {
  const scanned = roleScanTextOf(line);
  const words = scanned === undefined ? undefined : plainWordsOf(line, scanned);
  const parsed = words === undefined ? undefined : readable(words.slice(1), context.cli);
  if (words === undefined || parsed === undefined || !isServiceCommand(parsed.command)) {
    return undefined;
  }
  const command = parsed.command;
  const target = parseIssueTarget(parsed.positionals[0] ?? '');
  const session = parsed.flags.get('session');
  if (target === undefined || session === undefined) {
    return undefined;
  }
  if (!context.repos.includes(target.repo) || !(await matchesKit(SHAPES[command], words, context))) {
    return undefined;
  }
  return { command, target: targetText(target), session };
}

/**
 * The role call a Bash tool call runs; undefined for any other tool or line. A call only when its shell may run one
 * text (`toolCommandReadings`): a second reading comes only from a backslash run, which no role call holds.
 */
export async function toolRoleCallOf(tool: string | undefined, line: string, platform: NodeJS.Platform, context: RoleCallContext): Promise<RoleCall | undefined> {
  const readings = toolCommandReadings(tool, line, platform);
  const [only] = readings;
  return tool !== 'Bash' || readings.length !== 1 || only === undefined ? undefined : roleCallOf(only, context);
}
