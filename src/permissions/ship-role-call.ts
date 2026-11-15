import type { ParsedArgs } from '../cli/args.ts';
import { ABSOLUTE, type KitContext } from './route-kit.ts';

/**
 * The ship calls a service role lets run (T2984, design 1): `teamrig queue --kind ship|merge [--detach] --session <id>
 * [--what "<text>"] [--task <id>] [--max-minutes <n>] -- node [--disable-warning=ExperimentalWarning] <shipTool>` then
 * either `<worktree> <plan> [--merge [--approved <sha>] [--note-file <file>]]` or `merge <worktree> [--approved <sha>]
 * [--note-file <file>]`. Every path is absolute and each flag comes once; a base, a head, a timeout or any other word
 * is no ship call, so the line runs exactly the tool the team configured on the files this reader names; a line naming
 * no `--session` is none either (T2984, service-role-call.ts). Whether the worktree, the files and the tool may be
 * used is the allow's to check (hook-role-allow.ts): this reader reads only.
 */

/** What a ship call runs, for the allow to check. */
export interface ShipRun {
  /** The ship tool's script, as the line names it. */
  readonly tool: string;
  /** The worktree the tool ships or merges. */
  readonly worktree: string;
  /** The plan and note files the tool reads. */
  readonly files: readonly string[];
  /** The queue's `--task`, when the line names one. */
  readonly task: string | undefined;
  /** True for a merge: `--merge`, or the `merge` form. */
  readonly merges: boolean;
}

/** What reading a ship call needs beyond the CLI's table: whether a word names the team's configured ship tool. */
export interface ShipCallContext extends KitContext {
  readonly isShipTool: (word: string) => boolean;
}

/** The queue's options a ship call may carry; `--kind` must be there. */
const QUEUE_OPTIONS: ReadonlySet<string> = new Set(['kind', 'session', 'what', 'task', 'max-minutes', 'detach']);

/** The queue kinds a ship call runs under. */
const SHIP_KINDS: ReadonlySet<string> = new Set(['ship', 'merge']);

/** The one node flag a ship call may pass: it hides the type-stripping warning, and changes nothing the tool does. */
const NODE_FLAG = '--disable-warning=ExperimentalWarning';

/** A commit sha, short or full, as the tool's `--approved` takes it. */
const APPROVED_SHA = /^[0-9a-f]{7,40}$/;

/** The tool's words after its positionals: `--merge` alone, and two flags that take a value. */
const MERGE_SWITCH = '--merge';
const APPROVED = '--approved';
const NOTE_FILE = '--note-file';

/** A path the tool takes: absolute, so the allow checks the place the tool opens whatever its folder. */
function isPathWord(word: string | undefined): word is string {
  return word !== undefined && ABSOLUTE.test(word);
}

/** The tool's flags in `words`, each once and in its own slot; undefined for any other word. */
function toolFlagsOf(words: readonly string[], takesMerge: boolean): { merge: boolean; approved: boolean; note: string | undefined } | undefined {
  let merge = false;
  let approved = false;
  let note: string | undefined;
  for (let at = 0; at < words.length; at++) {
    const word = words[at];
    const value = words[at + 1];
    if (word === MERGE_SWITCH && takesMerge && !merge) {
      merge = true;
    } else if (word === APPROVED && !approved && value !== undefined && APPROVED_SHA.test(value)) {
      approved = true;
      at++;
    } else if (word === NOTE_FILE && note === undefined && isPathWord(value)) {
      note = value;
      at++;
    } else {
      return undefined;
    }
  }
  return { merge, approved, note };
}

/** The ship run the words after the queue's `--` make, when they run the configured tool in a ship shape. */
export function shipRunOf(rest: readonly string[], isShipTool: (word: string) => boolean, task: string | undefined): ShipRun | undefined {
  const [program, ...after] = rest;
  const [tool, ...args] = after[0] === NODE_FLAG ? after.slice(1) : after;
  if (program !== 'node' || !isPathWord(tool) || !isShipTool(tool)) {
    return undefined;
  }
  const mergeForm = args[0] === 'merge';
  const [worktree, plan] = mergeForm ? [args[1], undefined] : [args[0], args[1]];
  const flags = toolFlagsOf(args.slice(2), !mergeForm);
  if (!isPathWord(worktree) || (!mergeForm && !isPathWord(plan)) || flags === undefined) {
    return undefined;
  }
  // The tool reads --approved and --note-file only for a merge (ship-plan.ts), so a ship without --merge names neither.
  if (!mergeForm && !flags.merge && (flags.approved || flags.note !== undefined)) {
    return undefined;
  }
  const files = [plan, flags.note].filter((file) => file !== undefined);
  return { tool, worktree, files, task, merges: mergeForm || flags.merge };
}

/** The ship run a parsed `teamrig queue` line makes through this install's own launcher; undefined for any other line. */
export async function shipCallOf(program: string, parsed: ParsedArgs, context: ShipCallContext): Promise<ShipRun | undefined> {
  const options = [...parsed.flags.keys(), ...parsed.switches];
  const kind = parsed.flags.get('kind');
  if (parsed.command !== 'queue' || parsed.help || parsed.positionals.length > 0 || kind === undefined || !SHIP_KINDS.has(kind)) {
    return undefined;
  }
  if (!options.every((name) => QUEUE_OPTIONS.has(name))) {
    return undefined;
  }
  const run = shipRunOf(parsed.rest, context.isShipTool, parsed.flags.get('task'));
  return run !== undefined && (await context.ownClient(program)) ? run : undefined;
}
