import type { HookAsks } from '../config/types.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import type { ClientCheck } from '../exec/client-integrity.ts';
import { programsOf, type ProgramRun, type ProgramsContext } from '../package-guard/programs.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { holdBackOutput } from './permission.ts';

/**
 * The exec guard (T755, spec §7): an agent tab may run a `teamrig exec` review (approve, refuse, escalate) only as
 * itself. The allow line `Bash(teamrig exec *)` lets every exec command through unasked, and the CLI takes the
 * reviewer from `--session`, self-declared, so without this guard any tab could approve its own request as the
 * security reviewer or the owner. The owner never reviews through a tool call: they review in their own terminal, or
 * type `/teamrig exec approve R<n> --session <owner>` in a tab, which the mod runs without a PreToolUse hook.
 *
 * It also pins the client (spec §2.2, phase 1): every `teamrig exec` call, whatever its command, runs only while the
 * installed plugin's files are the ones its build hashed, as phase 1 runs an approved request inside that client.
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
  /** The installed client against its build's list, read only once a line runs `teamrig exec`. */
  readonly client: () => Promise<ClientCheck>;
}

/** A review a line runs: its action and every `--session` value it names. */
interface ReviewCall {
  readonly kind: 'review';
  readonly action: string;
  readonly sessions: readonly string[];
}

/** A `teamrig exec` call that decides no request (request, status, run and the rest): only the client pin applies. */
interface PlainCall {
  readonly kind: 'plain';
}

/** A teamrig call the guard cannot read: a word that decides whether it reviews, or as whom, is only known when it runs. */
interface UnreadableCall {
  readonly kind: 'unreadable';
}

type ExecCall = ReviewCall | PlainCall | UnreadableCall;

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
 * The exec call the words run, read as the CLI reads them (src/cli/args.ts): the first two words are the command, and
 * each flag of a review takes the word after it as its value. Undefined when they run no `teamrig exec` command.
 */
function execCallOf(words: readonly ShellWord[]): ExecCall | undefined {
  const [group, action] = words;
  if (group === undefined) {
    return undefined;
  }
  if (group.dynamic) {
    return { kind: 'unreadable' };
  }
  if (group.text !== 'exec') {
    return undefined;
  }
  if (action === undefined) {
    return { kind: 'plain' };
  }
  if (action.dynamic) {
    return { kind: 'unreadable' };
  }
  if (!REVIEW_ACTIONS.has(action.text)) {
    return { kind: 'plain' };
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

const UNREADABLE =
  'a teamrig call here has a word only known when it runs (a variable or a substitution), so the guard cannot tell whether it reviews a request, or as whom; write the words out.';

/** At most this many changed files are named in a refusal; the rest are counted. */
const NAMED_FILES = 5;

/** Why the guard refuses an exec call through this client, or undefined when its files are the ones the build hashed. */
function clientRefusalOf(check: ClientCheck): string | undefined {
  const fix = 'reinstall the teamrig plugin or ask security.';
  switch (check.kind) {
    case 'intact':
      return undefined;
    case 'no-manifest':
      return `the teamrig client cannot be checked against its build (${check.why}), so it may have been changed; ${fix}`;
    case 'changed': {
      const more = check.paths.length > NAMED_FILES ? ` and ${check.paths.length - NAMED_FILES} more` : '';
      return `the teamrig client was changed after its build (${check.paths.slice(0, NAMED_FILES).join(', ')}${more}); ${fix}`;
    }
  }
}

/** Why the guard refuses a review, or undefined when it runs as the tab's own session. */
function reviewRefusalOf(call: ReviewCall, identity: TabIdentity): string | undefined {
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
 * set on the line changes nothing), when the guard cannot read who it reviews as, or when it runs any `teamrig exec`
 * command while the client differs from its build; else nothing, so the normal permission flow decides. It checks the
 * client only for a line that runs `teamrig exec`, and reads the tab's session only for a line that holds a review.
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
  const reasons: string[] = calls.some((call) => call.kind === 'unreadable') ? [UNREADABLE] : [];
  if (calls.some((call) => call.kind !== 'unreadable')) {
    const client = clientRefusalOf(await env.client());
    if (client !== undefined) {
      reasons.push(client);
    }
  }
  const reviews = calls.filter((call) => call.kind === 'review');
  if (reviews.length > 0) {
    const identity = await env.identity();
    reasons.push(...reviews.map((call) => reviewRefusalOf(call, identity)).filter((reason) => reason !== undefined));
  }
  return reasons.length === 0 ? '' : holdBackOutput('deny', `teamrig exec guard: ${[...new Set(reasons)].join(' ')}`, env.hookAsks);
}
