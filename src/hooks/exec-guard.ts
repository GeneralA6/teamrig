import type { HookAsks } from '../config/types.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { programsOf, type ProgramRun, type ProgramsContext } from '../package-guard/programs.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { holdBackOutput } from './permission.ts';

/**
 * The exec guard (T755, spec §7): an agent tab may run a `teamrig exec` review (approve, refuse, escalate) only as
 * itself. The allow line `Bash(teamrig exec *)` lets every exec command through unasked, and the CLI takes the
 * reviewer from `--session`, self-declared, so without this guard any tab could approve its own request as the
 * security reviewer or the owner. The owner never reviews through a tool call: they review in their own terminal, or
 * type `/teamrig exec approve R<n> --session <owner>` in a tab, which the mod runs without a PreToolUse hook.
 */

/** The `teamrig exec` commands that decide a request. */
export const REVIEW_ACTIONS: ReadonlySet<string> = new Set(['approve', 'refuse', 'escalate']);

/** Who the tab runs as, read only once a line holds a review. */
export type TabIdentity =
  | {
      readonly kind: 'bound';
      /** The tab's team session id. */
      readonly session: string;
      /** The owner's marker (register.ownerSource), which a tool call never reviews as. */
      readonly owner: string;
      /** The session id a `--session` word names, or undefined when it names none of the team. */
      readonly idOf: (name: string) => string | undefined;
    }
  | { readonly kind: 'unbound'; readonly why: string };

export interface ExecGuardEnv {
  /** The folder to read the line from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  readonly hookAsks: HookAsks;
  readonly identity: () => Promise<TabIdentity>;
}

/** A review a line runs: its action and every `--session` value it names. */
interface ReviewCall {
  readonly kind: 'review';
  readonly action: string;
  readonly sessions: readonly string[];
}

/** A teamrig call the guard cannot read: a word that decides whether it reviews, or as whom, is only known when it runs. */
interface UnreadableCall {
  readonly kind: 'unreadable';
}

type ExecCall = ReviewCall | UnreadableCall;

/** teamrig's own entry point when a line runs it through node: `node <plugin>/dist/cli/main.js exec ...`. */
const CLI_ENTRY = /[\\/]cli[\\/]main\.[jt]s$/i;

/** The words a run hands the teamrig CLI, or undefined when it does not run teamrig. */
function teamrigWordsOf(run: ProgramRun): readonly ShellWord[] | undefined {
  if (run.name === 'teamrig' || run.name === 'teamrig.ps1') {
    return run.args;
  }
  if (run.name !== 'node') {
    return undefined;
  }
  const entry = run.args.findIndex((word) => CLI_ENTRY.test(word.text));
  return entry === -1 ? undefined : run.args.slice(entry + 1);
}

/**
 * The review the words run, read as the CLI reads them (src/cli/args.ts): the first two words are the command, and
 * each flag of a review takes the word after it as its value. Undefined when they run no review.
 */
function execCallOf(words: readonly ShellWord[]): ExecCall | undefined {
  const [group, action] = words;
  if (group === undefined) {
    return undefined;
  }
  if (group.dynamic) {
    return { kind: 'unreadable' };
  }
  if (group.text !== 'exec' || action === undefined) {
    return undefined;
  }
  if (action.dynamic) {
    return { kind: 'unreadable' };
  }
  if (!REVIEW_ACTIONS.has(action.text)) {
    return undefined;
  }
  const tail = words.slice(2);
  if (tail.some((word) => word.dynamic)) {
    return { kind: 'unreadable' };
  }
  const sessions: string[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index]?.text ?? '';
    if (!token.startsWith('--')) {
      continue;
    }
    const value = tail[index + 1];
    if (token === '--session' && value !== undefined) {
      sessions.push(value.text);
    }
    index += 1;
  }
  return { kind: 'review', action: action.text, sessions };
}

/** Why the guard refuses a call, or undefined when it runs as the tab's own session. */
function refusalOf(call: ExecCall, identity: TabIdentity): string | undefined {
  if (call.kind === 'unreadable') {
    return 'a teamrig call here has a word only known when it runs (a variable or a substitution), so the guard cannot tell whether it reviews a request, or as whom; write the words out.';
  }
  const command = `\`teamrig exec ${call.action}\``;
  if (identity.kind === 'unbound') {
    return `${command} reviews a request, and ${identity.why}, so the guard cannot tell who reviews.`;
  }
  const own = `--session ${identity.session}`;
  const [named, twice] = call.sessions;
  if (named === undefined) {
    return `${command} names no --session; name this tab's own (${own}): $TEAMRIG_SESSION cannot show who runs the line.`;
  }
  if (twice !== undefined) {
    return `${command} names --session more than once; name this tab's own once (${own}).`;
  }
  if (named === identity.owner) {
    return (
      `${command} names the owner (--session ${named}); the owner reviews in their own terminal, or types ` +
      `\`/teamrig exec ${call.action} R<n> --session ${named}\` in a tab, never through a tool call.`
    );
  }
  const id = identity.idOf(named);
  if (id === undefined) {
    return `${command} names --session ${named}, no session of the team; a session reviews only as itself (${own}).`;
  }
  return id === identity.session ? undefined : `${command} names --session ${named}, but this tab is ${identity.session}'s; a session reviews only as itself (${own}).`;
}

/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal when the line runs a `teamrig exec` review as anyone
 * but the tab's own session, named by `--session` (the flag wins over `$TEAMRIG_SESSION` in the CLI, so a variable
 * set on the line changes nothing), or when the guard cannot read who it reviews as; else nothing, so the normal
 * permission flow decides. It reads the tab's session only for a line that holds a review.
 */
export async function execGuardOutput(payload: unknown, env: ExecGuardEnv): Promise<string> {
  if (!isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined) {
    return '';
  }
  const context: ProgramsContext = {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: stringField(payload, 'tool_name') === 'PowerShell' ? 'powershell' : 'bash',
  };
  const calls = programsOf(command, context)
    .map(teamrigWordsOf)
    .filter((words) => words !== undefined)
    .map(execCallOf)
    .filter((call) => call !== undefined);
  if (calls.length === 0) {
    return '';
  }
  const identity = await env.identity();
  const reasons = calls.map((call) => refusalOf(call, identity)).filter((reason) => reason !== undefined);
  return reasons.length === 0 ? '' : holdBackOutput('deny', `teamrig exec guard: ${[...new Set(reasons)].join(' ')}`, env.hookAsks);
}
