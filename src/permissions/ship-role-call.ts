import { posix, win32 } from 'node:path';
import type { ParsedArgs } from '../cli/args.ts';
import { ABSOLUTE, type KitContext } from './route-kit.ts';

/**
 * The ship calls a service role lets run (T2984, design 1): `teamrig queue --kind test|ship|merge [--detach] --session <id>
 * [--what "<text>"] [--task <id>] [--max-minutes <n>] -- node [--disable-warning=ExperimentalWarning] <shipTool>` then
 * either `<worktree> <plan> [--merge [--approved <sha>] [--note-file <file>]]`, `merge <worktree> [--approved <sha>]
 * [--note-file <file>]` or the release merge `merge <main checkout> --release <task> --approved <sha>` (T4645, T4672),
 * which merges the release pull request on that task's approval and opens no pull request, so it names no note file
 * and always the approved sha. Every path is absolute and each flag comes once; a base, a head, a timeout or any other word
 * is no ship call, so the line runs exactly the tool the team configured on the files this reader names; a line naming
 * no `--session` is none either (T2984, service-role-call.ts). Whether the worktree, the files and the tool may be
 * used is the allow's to check (hook-role-allow.ts): this reader reads only. The kind fits the run, as the queue
 * refuses one that does not (T3414): a merge under `ship` or `merge`, which take the ship slot, and a ship without
 * --merge under `test`, which moves no main branch and so takes no slot.
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
  /** The release task a release merge (`merge <dir> --release <task>`) names; undefined for any other ship call. */
  readonly release: string | undefined;
}

/** What reading a ship call needs beyond the CLI's table: whether a word names the team's configured ship tool. */
export interface ShipCallContext extends KitContext {
  readonly isShipTool: (word: string) => boolean;
}

/** The queue's options a ship call may carry; `--kind` must be there. */
const QUEUE_OPTIONS: ReadonlySet<string> = new Set(['kind', 'session', 'what', 'task', 'max-minutes', 'detach']);

/** The queue kinds a ship call that merges runs under: the ones that take the ship slot. */
const MERGE_KINDS: ReadonlySet<string> = new Set(['ship', 'merge']);

/** The queue kind a ship call without --merge runs under. */
const REVIEW_KIND = 'test';

/** The one node flag a ship call may pass: it hides the type-stripping warning, and changes nothing the tool does. */
const NODE_FLAG = '--disable-warning=ExperimentalWarning';

/** A commit sha, short or full, as the tool's `--approved` takes it. */
const APPROVED_SHA = /^[0-9a-f]{7,40}$/;

/** A task id, as the tool's `--release` takes it. */
const RELEASE_TASK = /^T\d+$/;

/** The tool's words after its positionals: `--merge` alone, and three flags that take a value. */
const MERGE_SWITCH = '--merge';
const APPROVED = '--approved';
const NOTE_FILE = '--note-file';
const RELEASE = '--release';

/** The tool's flags a line names. */
interface ToolFlags {
  readonly merge: boolean;
  readonly approved: boolean;
  readonly note: string | undefined;
  readonly release: string | undefined;
}

/** A path the tool takes: absolute, so the allow checks the place the tool opens whatever its folder. */
function isPathWord(word: string | undefined): word is string {
  return word !== undefined && ABSOLUTE.test(word);
}

/**
 * The tool's flags in `words`, each once and in its own slot; undefined for any other word. `mergeForm` is the `merge`
 * form, which takes `--release` and never `--merge`.
 */
function toolFlagsOf(words: readonly string[], mergeForm: boolean): ToolFlags | undefined {
  let merge = false;
  let approved = false;
  let note: string | undefined;
  let release: string | undefined;
  for (let at = 0; at < words.length; at++) {
    const word = words[at];
    const value = words[at + 1];
    if (word === MERGE_SWITCH && !mergeForm && !merge) {
      merge = true;
    } else if (word === APPROVED && !approved && value !== undefined && APPROVED_SHA.test(value)) {
      approved = true;
      at++;
    } else if (word === NOTE_FILE && note === undefined && isPathWord(value)) {
      note = value;
      at++;
    } else if (word === RELEASE && mergeForm && release === undefined && value !== undefined && RELEASE_TASK.test(value)) {
      release = value;
      at++;
    } else {
      return undefined;
    }
  }
  return { merge, approved, note, release };
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
  const flags = toolFlagsOf(args.slice(2), mergeForm);
  if (!isPathWord(worktree) || (!mergeForm && !isPathWord(plan)) || flags === undefined) {
    return undefined;
  }
  // The tool reads --approved and --note-file only for a merge (ship-plan.ts), so a ship without --merge names neither.
  if (!mergeForm && !flags.merge && (flags.approved || flags.note !== undefined)) {
    return undefined;
  }
  // A release merge opens no pull request, so it reads no note (merge.ts refuses one), and it lands only an approved head.
  if (flags.release !== undefined && (flags.note !== undefined || !flags.approved)) {
    return undefined;
  }
  const files = [plan, flags.note].filter((file) => file !== undefined);
  return { tool, worktree, files, task, merges: mergeForm || flags.merge, release: flags.release };
}

/** The ship run a parsed `teamrig queue` line makes through this install's own launcher; undefined for any other line. */
export async function shipCallOf(program: string, parsed: ParsedArgs, context: ShipCallContext): Promise<ShipRun | undefined> {
  const options = [...parsed.flags.keys(), ...parsed.switches];
  const kind = parsed.flags.get('kind');
  if (parsed.command !== 'queue' || parsed.help || parsed.positionals.length > 0 || kind === undefined || (!MERGE_KINDS.has(kind) && kind !== REVIEW_KIND)) {
    return undefined;
  }
  if (!options.every((name) => QUEUE_OPTIONS.has(name))) {
    return undefined;
  }
  const run = shipRunOf(parsed.rest, context.isShipTool, parsed.flags.get('task'));
  if (run === undefined || run.merges !== MERGE_KINDS.has(kind)) {
    return undefined;
  }
  return (await context.ownClient(program)) ? run : undefined;
}

/** `word` read from the folder `cwd`, in that folder's own path style, so a reading never depends on this host's. */
function placeOf(cwd: string, word: string): string {
  return ABSOLUTE.test(cwd) && !cwd.startsWith('/') ? win32.resolve(cwd, word) : posix.resolve(cwd, word);
}

/**
 * Why a `teamrig queue` line through this install's own launcher that runs the team's ship tool (`isShipTool`, a
 * relative path read from the call's folder `cwd`) is no ship call: each condition it failed, in plain words, for the
 * route-allow hook to hand back as context (#1468). Empty for a line in the ship call's form with its `--session`, and
 * for any line that names no ship tool: only a near miss gets a hint. It decides nothing: the allow reads the line
 * through shipCallOf alone.
 */
export async function shipNearMissOf(program: string, parsed: ParsedArgs, context: ShipCallContext, cwd: string | undefined): Promise<readonly string[]> {
  if (parsed.command !== 'queue' || parsed.help || !(await context.ownClient(program))) {
    return [];
  }
  const [runner, ...after] = parsed.rest;
  const at = after[0] === NODE_FLAG ? 2 : 1;
  const tool = parsed.rest[at];
  if (runner !== 'node' || tool === undefined) {
    return [];
  }
  const relative = !isPathWord(tool);
  const place = relative ? (cwd === undefined ? undefined : placeOf(cwd, tool)) : tool;
  if (place === undefined || !context.isShipTool(place)) {
    return [];
  }
  const session = parsed.flags.get('session');
  if (!relative && session !== undefined && (await shipCallOf(program, parsed, context)) !== undefined) {
    return [];
  }
  const failed: string[] = [];
  if (relative) {
    failed.push(`the ship tool path ${tool} is relative: name it absolute, ${place}`);
  }
  if (session === undefined) {
    failed.push('no --session: a role call names the session it runs as');
  }
  for (const name of [...parsed.flags.keys(), ...parsed.switches].filter((option) => !QUEUE_OPTIONS.has(option))) {
    failed.push(`the queue flag --${name} is not one a ship call takes`);
  }
  if (parsed.positionals.length > 0) {
    failed.push(`the word ${parsed.positionals[0] ?? ''} before -- is not one a ship call takes`);
  }
  const kind = parsed.flags.get('kind');
  const rest = parsed.rest.map((word, index) => (index === at ? place : word));
  const run = shipRunOf(rest, context.isShipTool, parsed.flags.get('task'));
  if (run === undefined) {
    failed.push("the ship tool's words are not its ship or merge form: an extra word or flag, or a worktree, plan or note path that is not absolute");
  } else if (kind === undefined) {
    failed.push('no --kind: a ship runs under test, a merge under ship or merge');
  } else if (run.merges !== MERGE_KINDS.has(kind) || (!MERGE_KINDS.has(kind) && kind !== REVIEW_KIND)) {
    failed.push(`--kind ${kind} does not fit the run: a merge runs under ship or merge, a ship without --merge under test`);
  }
  return failed;
}
