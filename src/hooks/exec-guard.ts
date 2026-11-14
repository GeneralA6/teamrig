import type { HookAsks } from '../config/types.ts';
import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import type { ClientCheck } from '../exec/client-integrity.ts';
import { placeProgram, placeScript, type ClientFile, type ClientInstalls, type ClientSearch, type WordAt } from '../exec/client-launch.ts';
import { runsOf, type LineRuns, type OpaqueRun, type ProgramRun, type ProgramsContext } from '../package-guard/programs.ts';
import { programName } from '../push-guard/launchers.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { ghWriteOf, type GhWrite } from './gh-writes.ts';
import { holdBackOutput } from './permission.ts';

/**
 * The exec guard (T755, spec §7): an agent tab may run a `teamrig exec` review (approve, refuse, escalate) only as
 * itself. The allow line `Bash(teamrig exec *)` lets every exec command through unasked, and the CLI takes the
 * reviewer from `--session`, self-declared, so without this guard any tab could approve its own request as the
 * security reviewer or the owner. The owner never reviews through a tool call: they review in their own terminal, or
 * type `/teamrig exec approve R<n> --session <owner>` in a tab, which the mod runs without a PreToolUse hook. A teamrig
 * call with a word only known when it runs that decides whether it reviews, or as whom, is refused: its subcommand
 * too (`teamrig "$G" approve R1`, or `f(){ teamrig "$@"; }; f exec approve ...`), as reviews are not signed (T1780).
 * So is a line whose shell takes its commands from a pipe (`echo ... | bash`, `... | iex`), whatever feeds it, as a
 * pipe can carry a review the line never shows (T1855); a heredoc it reads is judged as written.
 *
 * It also pins the client (spec §2.2, phase 1): every `teamrig exec` call, whatever its command, runs only through an
 * install of this plugin whose files are the ones its build hashed, as phase 1 runs an approved request inside that
 * client. The guard places the file a call starts as its shell would (T803): a path the line writes, or the first
 * `teamrig` the shell's PATH search finds, where a `~/bin/teamrig` wins over the plugin bin the Bash tool appends
 * last; a call through a program only known when it runs (`$T exec ...`) is refused, as no file can be checked.
 *
 * It refuses every `teamrig owner` call too (T1298): `owner note`, `owner next` and `owner wake` write or wake as the
 * owner (register.ownerSource) whoever runs them, and `owner github-admin` names the GitHub admin (T2705), so only the owner's own routes run them: the pane, their own terminal, or
 * `/teamrig owner ...` typed in a tab, which the mod runs as a write only when the person types it. Like the review
 * check, it reads only a Bash or PowerShell tool call: a script the agent writes that starts the CLI is no such call.
 *
 * And it guards who writes on GitHub (T2705): `teamrig issue comment` and `close` let a session write only on its own
 * issues and pull requests, the GitHub admin on the rest, by the session the CLI takes from `--session`; so a tool
 * call must name the tab's own, as a review must. On a team whose issues are on GitHub (`github.repos`), a raw `gh`
 * call that writes on an issue or pull request (hooks/gh-writes.ts) is refused too, as it skips that check.
 */

/** The `teamrig exec` commands that decide a request. */
export const REVIEW_ACTIONS: ReadonlySet<string> = new Set(['approve', 'refuse', 'escalate']);

/** Every `teamrig exec` command, by which a call through an unknown program reads as a teamrig call, not as `docker exec`. */
export const EXEC_COMMANDS: ReadonlySet<string> = new Set(['request', 'dry-run', ...REVIEW_ACTIONS, 'run', 'status']);

/** Every `teamrig owner` command, by which a call through an unknown program reads as a teamrig call. */
export const OWNER_COMMANDS: ReadonlySet<string> = new Set(['note', 'next', 'wake', 'github-admin']);

/** The `teamrig issue` commands that write on an issue or pull request, as the session `--session` names. */
export const ISSUE_WRITES: ReadonlySet<string> = new Set(['comment', 'close']);

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
  /** The installs a call may start: the hook's own, and the other versions beside it in the plugin cache. */
  readonly installs: ClientInstalls;
  /** The file a shell starts for a bare `teamrig`, by its PATH search. */
  readonly search: ClientSearch;
  /** An install's client against its build's list, read once per install a line's `teamrig exec` calls start. */
  readonly checkClient: (root: string) => Promise<ClientCheck>;
  /** The host's platform: on Windows a Bash line is read as written and as bash receives it (core/bash-tool-readings.ts). */
  readonly platform: NodeJS.Platform;
  /** True when the team's issues are on GitHub (`github.repos` names one): a raw `gh` write on an issue or pull request is refused. */
  readonly githubIssues: boolean;
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

/** A `teamrig owner` call, which acts as the owner whoever runs it: refused whatever its client. */
interface OwnerCall {
  readonly kind: 'owner';
  /** Its command when the line names one the CLI has, else undefined. */
  readonly action: string | undefined;
}

/** A `teamrig issue` write, which writes as the session `--session` names: each `--session` value, as written. */
interface IssueCall {
  readonly kind: 'issue';
  readonly action: string;
  readonly sessions: readonly ShellWord[];
}

type GuardedCall = ReviewCall | PlainCall | UnreadableCall | OwnerCall | IssueCall;

/** teamrig's own entry point when a line runs it through node: `node <plugin>/dist/cli/main.js exec ...`. */
const CLI_ENTRY = /[\\/]cli[\\/]main\.[jt]s$/i;

/** The word that names a call's client: a program word (`teamrig`, `C:/kit/bin/teamrig`), node's script, or a word only known when it runs. */
interface ClientWord {
  readonly kind: 'program' | 'script' | 'opaque';
  readonly word: ShellWord;
}

/** How a run starts the teamrig CLI: the word naming its client, and the words it hands the CLI. */
interface TeamrigLaunch {
  readonly client: ClientWord;
  readonly words: readonly ShellWord[];
}

/** True when the words a program only known when it runs takes read as a command of the teamrig group: `exec approve`, `exec "$CMD"`. */
function startsGroup(words: readonly ShellWord[], name: string, commands: ReadonlySet<string>): boolean {
  const [group, command] = words;
  return group !== undefined && !group.dynamic && group.text === name && command !== undefined && (command.dynamic || commands.has(command.text));
}

/** True when the words read as a teamrig exec command. */
function startsExec(words: readonly ShellWord[]): boolean {
  return startsGroup(words, 'exec', EXEC_COMMANDS);
}

/** True when the words read as a teamrig issue write. */
function startsIssue(words: readonly ShellWord[]): boolean {
  return startsGroup(words, 'issue', ISSUE_WRITES);
}

/** True when the words read as a teamrig owner command. */
function startsOwner(words: readonly ShellWord[]): boolean {
  return startsGroup(words, 'owner', OWNER_COMMANDS);
}

/** The owner command the words name after `owner`, or undefined when they name none the CLI has, or one only known when it runs. */
function ownerActionOf(words: readonly ShellWord[]): string | undefined {
  const action = words[1];
  return action === undefined || action.dynamic || !OWNER_COMMANDS.has(action.text) ? undefined : action.text;
}

/** How a run starts the teamrig CLI, or undefined when it does not: by name, by node and teamrig's entry, or by node and a script only known when it runs. */
function teamrigLaunchOf(run: ProgramRun): TeamrigLaunch | undefined {
  if (run.name === 'teamrig' || run.name === 'teamrig.ps1') {
    return { client: { kind: 'program', word: run.program }, words: run.args };
  }
  if (run.name !== 'node') {
    return undefined;
  }
  const entry = run.args.findIndex((word) => CLI_ENTRY.test(word.text));
  const script = entry === -1 ? run.args.find((word) => !word.text.startsWith('-')) : run.args[entry];
  if (script === undefined) {
    return undefined;
  }
  const words = run.args.slice(run.args.indexOf(script) + 1);
  if (!script.dynamic) {
    return entry === -1 ? undefined : { client: { kind: 'script', word: script }, words };
  }
  return entry !== -1 || startsExec(words) || startsOwner(words) || startsIssue(words) ? { client: { kind: 'opaque', word: script }, words } : undefined;
}

/** True for a teamrig call whose subcommand is only known when it runs (`teamrig "$G" approve R1`), which the walker leaves unread. */
function hidesSubcommand(run: OpaqueRun): boolean {
  return !run.program.dynamic && programName(run.program.text) === 'teamrig';
}

/** Each `--session` value the words name, as the CLI reads flags (src/cli/args.ts): each flag takes the word after it. */
function sessionWordsOf(tail: readonly ShellWord[]): ShellWord[] {
  const sessions: ShellWord[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    const token = tail[index]?.text ?? '';
    if (!token.startsWith('--')) {
      continue;
    }
    const value = tail[index + 1];
    if (token === '--session' && value !== undefined) {
      sessions.push(value);
    }
    index += 1;
  }
  return sessions;
}

/**
 * The `teamrig issue` write the words run, or undefined for a command that writes nothing (`issue similar`). A word
 * only known when it runs may stand anywhere but in the command or the `--session` value: the CLI refuses a flag
 * given twice, and a value that starts with `--`, so no such word can name the session past a written-out one.
 */
function issueCallOf(words: readonly ShellWord[]): GuardedCall | undefined {
  const action = words[1];
  if (action === undefined) {
    return undefined;
  }
  if (action.dynamic) {
    return { kind: 'unreadable' };
  }
  return ISSUE_WRITES.has(action.text) ? { kind: 'issue', action: action.text, sessions: sessionWordsOf(words.slice(2)) } : undefined;
}

/**
 * The guarded call the words run, read as the CLI reads them (src/cli/args.ts): the first two words are the command,
 * and each flag of a review takes the word after it as its value. Undefined when they run no `teamrig exec`,
 * `teamrig owner` or `teamrig issue` write.
 */
function guardedCallOf(words: readonly ShellWord[]): GuardedCall | undefined {
  const [group, action] = words;
  if (group === undefined) {
    return undefined;
  }
  if (group.dynamic) {
    return { kind: 'unreadable' };
  }
  if (group.text === 'owner') {
    return { kind: 'owner', action: ownerActionOf(words) };
  }
  if (group.text === 'issue') {
    return issueCallOf(words);
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
  return { kind: 'review', action: action.text, sessions: sessionWordsOf(tail).map((word) => word.text) };
}

const UNREADABLE =
  'a teamrig call here has a word only known when it runs (a variable or a substitution), so the guard cannot tell whether it reviews a request, or as whom; write the words out.';

const FED_SHELL =
  'a shell here reads its commands from a pipe, so the guard cannot tell whether they review a request or act as the owner; run them directly, or hand the shell a heredoc, which the guard reads.';

/** At most this many changed files are named in a refusal; the rest are counted. */
const NAMED_FILES = 5;

/** Where the plugin's own client is, for a refusal to name: `<install>/bin/teamrig`. */
function ownClientOf(installs: ClientInstalls): string {
  return `${installs.install}/bin/teamrig`;
}

/** Why the guard refuses an exec call through the install at `root`, or undefined when its files are the ones the build hashed. */
function clientRefusalOf(check: ClientCheck, root: string, installs: ClientInstalls): string | undefined {
  const own = installs.isOwn(root);
  const client = own ? 'the teamrig client' : `the teamrig client at ${root}`;
  const fix = own ? 'reinstall the teamrig plugin or ask security.' : `run the plugin's own (${ownClientOf(installs)}), or ask security.`;
  switch (check.kind) {
    case 'intact':
      return undefined;
    case 'no-manifest':
      return `${client} cannot be checked against its build (${check.why}), so it may have been changed; ${fix}`;
    case 'changed': {
      const more = check.paths.length > NAMED_FILES ? ` and ${check.paths.length - NAMED_FILES} more` : '';
      return `${client} was changed after its build (${check.paths.slice(0, NAMED_FILES).join(', ')}${more}); ${fix}`;
    }
  }
}

/** Why the guard refuses a client file that is no install of this plugin. */
function foreignRefusalOf(file: Extract<ClientFile, { kind: 'file' }>, installs: ClientInstalls, group: string): string {
  const own = ownClientOf(installs);
  return file.by === 'found'
    ? `the \`teamrig\` this line's shell finds on PATH is ${file.path}, no install of the teamrig plugin; remove it from PATH, or run the plugin's own (${own}).`
    : `\`teamrig ${group}\` here starts ${file.path}, no install of the teamrig plugin; run the plugin's own (${own}).`;
}

/** Why the guard refuses a `teamrig owner` call: the routes the owner runs it by. */
function ownerRefusalOf(action: string | undefined): string {
  const command = action === undefined ? 'teamrig owner' : `teamrig owner ${action}`;
  return `\`${command}\` acts as the owner; the owner runs it from the pane or their own terminal, or types \`/${command} ...\` in a tab, never through a tool call.`;
}

/** Why the guard refuses a call through a program only known when it runs; `group` is the teamrig group it runs, such as exec. */
function opaqueRefusalOf(word: ShellWord, group: string): string {
  return `\`teamrig ${group}\` here starts a program only known when it runs (${word.text}), so the guard cannot tell which client runs it; write it out: \`teamrig\`, or its full path.`;
}

/** What a teamrig call's client word starts: the install root it is an entry of, or why the guard refuses it. */
type ClientRoot = { readonly kind: 'root'; readonly root: string } | { readonly kind: 'refused'; readonly why: string };

/** The install a call's client word starts, placed as the line's shell places it; `group` is the teamrig group the call runs. */
async function clientRootOf(client: ClientWord, at: WordAt, env: ExecGuardEnv, group: string): Promise<ClientRoot> {
  if (client.kind === 'opaque') {
    return { kind: 'refused', why: opaqueRefusalOf(client.word, group) };
  }
  const file = client.kind === 'program' ? await placeProgram(client.word.text, at, env.search) : placeScript(client.word.text, at);
  switch (file.kind) {
    case 'appended':
      return { kind: 'root', root: env.installs.install };
    case 'unplaced':
      return {
        kind: 'refused',
        why: `a teamrig call here starts its client by a relative path (${client.word.text}) from a folder only known when the line runs; write its full path.`,
      };
    case 'file': {
      const root = env.installs.rootOf(file.path);
      return root === undefined ? { kind: 'refused', why: foreignRefusalOf(file, env.installs, group) } : { kind: 'root', root };
    }
  }
}

/** A call that acts as the session `--session` names, as a refusal words it. */
interface ActingCall {
  /** The command, quoted: `teamrig exec approve`. */
  readonly command: string;
  /** What it does, after the command: `reviews a request`. */
  readonly does: string;
  /** Its verb for a session acting: `reviews`. */
  readonly verb: string;
  /** Why the owner never runs it through a tool call, for a `--session` that names the owner. */
  readonly ownerRoute: (named: string) => string;
  readonly sessions: readonly ShellWord[];
}

/** A review as an acting call. */
function reviewActing(call: ReviewCall): ActingCall {
  return {
    command: `\`teamrig exec ${call.action}\``,
    does: 'reviews a request',
    verb: 'reviews',
    ownerRoute: (named) => `the owner reviews in their own terminal, or types \`/teamrig exec ${call.action} R<n> --session ${named}\` in a tab, never through a tool call.`,
    sessions: call.sessions.map((text) => ({ text, dynamic: false })),
  };
}

/** A `teamrig issue` write as an acting call. */
function issueActing(call: IssueCall): ActingCall {
  return {
    command: `\`teamrig issue ${call.action}\``,
    does: 'writes on GitHub',
    verb: 'writes',
    ownerRoute: () => '`teamrig issue` writes as a session of the team, never as the owner.',
    sessions: call.sessions,
  };
}

/** Why the guard refuses a call that acts as `--session`, or undefined when it names the tab's own session, written out once. */
function actingRefusalOf(call: ActingCall, identity: TabIdentity): string | undefined {
  const { command, verb } = call;
  if (identity.kind === 'unbound') {
    return `${command} ${call.does}, and ${identity.why}, so the guard cannot tell who ${verb}.`;
  }
  const own = `--session ${identity.session}`;
  const [named, twice] = call.sessions;
  if (named === undefined) {
    return `${command} names no --session; name this tab's own (${own}): $TEAMRIG_SESSION cannot show who runs the line.`;
  }
  if (twice !== undefined) {
    return `${command} names --session more than once; name this tab's own once (${own}).`;
  }
  if (named.dynamic) {
    return `${command} names --session by a word only known when it runs (${named.text}); write this tab's own out (${own}).`;
  }
  if (named.text === identity.owner) {
    return `${command} names the owner (--session ${named.text}); ${call.ownerRoute(named.text)}`;
  }
  const id = identity.idOf(named.text);
  if (id === undefined) {
    return `${command} names --session ${named.text}, no session of the team; a session ${verb} only as itself (${own}).`;
  }
  return id === identity.session ? undefined : `${command} names --session ${named.text}, but this tab is ${identity.session}'s; a session ${verb} only as itself (${own}).`;
}

/** Why the guard refuses a raw `gh` write on an issue or pull request. */
function ghRefusalOf(write: GhWrite): string {
  const route = 'use `teamrig issue comment` or `teamrig issue close`, which check who may write (each session its own issues and pull requests, the GitHub admin the rest)';
  return write.kind === 'write'
    ? `\`${write.what}\` writes on an issue or pull request past teamrig's check of who may; ${route}.`
    : `\`${write.what}\` has a word only known when it runs, so the guard cannot tell whether it writes on an issue or pull request; write it out, and for a write ${route}.`;
}

/** The writes on issues and pull requests a line's `gh` calls make, and those of a program only known when it runs whose words read as one (`$GH issue close 7`). */
function ghWritesOf(runs: LineRuns): GhWrite[] {
  const words = [...runs.programs.filter((run) => run.name === 'gh').map((run) => run.args), ...runs.opaque.map((run) => run.args)];
  return words.flatMap((args) => {
    const write = ghWriteOf(args);
    return write === undefined ? [] : [write];
  });
}

/**
 * What every reading of a tool call runs, reading after reading. Joining them is safe, unlike the push guard's
 * checkouts: each run carries its own folder and shell, and the guard refuses a run whatever else the line runs.
 */
function runsOfReadings(readings: readonly string[], context: ProgramsContext): LineRuns {
  const each = readings.map((text) => runsOf(text, context));
  return {
    programs: each.flatMap((runs) => runs.programs),
    bare: each.flatMap((runs) => runs.bare),
    opaque: each.flatMap((runs) => runs.opaque),
    fedShells: each.flatMap((runs) => runs.fedShells),
  };
}

/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal when the line runs a `teamrig exec` review as anyone
 * but the tab's own session, named by `--session` (the flag wins over `$TEAMRIG_SESSION` in the CLI, so a variable
 * set on the line changes nothing), when the guard cannot read who it reviews as, or when it runs any `teamrig exec`
 * command through a client that is no install of this plugin, one only known when it runs, or one whose files differ
 * from its build; whenever the line runs a `teamrig owner` command, through any client, as it acts as the owner; and
 * when a shell on the line takes its commands from a pipe the guard cannot read. Else nothing, so the normal permission flow decides. It checks each install a line's `teamrig exec` calls start
 * once, and reads the tab's session only for a line that holds a review. A Bash line on Windows is read in each
 * reading bash may run (`toolCommandReadings`), so a call the line as written escapes is still refused.
 */
export async function execGuardOutput(payload: unknown, env: ExecGuardEnv): Promise<string> {
  if (!isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined) {
    return '';
  }
  const tool = stringField(payload, 'tool_name');
  const context: ProgramsContext = {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: tool === 'PowerShell' ? 'powershell' : 'bash',
  };
  const runs = runsOfReadings(toolCommandReadings(tool, command, env.platform), context);
  const calls = runs.programs.flatMap((run) => {
    const launch = teamrigLaunchOf(run);
    const call = launch === undefined ? undefined : guardedCallOf(launch.words);
    const at: WordAt = { dialect: run.dialect, dir: run.dir, home: env.home };
    return launch === undefined || call === undefined ? [] : [{ call, client: launch.client, at }];
  });
  const opaque = runs.opaque.filter((run) => startsExec(run.args));
  const opaqueIssue = runs.opaque.filter((run) => startsIssue(run.args));
  const opaqueOwner = runs.opaque.filter((run) => startsOwner(run.args));
  const ghWrites = env.githubIssues ? ghWritesOf(runs) : [];
  const unread = runs.opaque.some(hidesSubcommand) || calls.some(({ call }) => call.kind === 'unreadable');
  const fed = runs.fedShells.length > 0;
  if (calls.length === 0 && opaque.length === 0 && opaqueIssue.length === 0 && opaqueOwner.length === 0 && ghWrites.length === 0 && !unread && !fed) {
    return '';
  }
  const reasons: string[] = [...(unread ? [UNREADABLE] : []), ...(fed ? [FED_SHELL] : [])];
  reasons.push(...opaque.map((run) => opaqueRefusalOf(run.program, 'exec')));
  reasons.push(...opaqueIssue.map((run) => opaqueRefusalOf(run.program, 'issue')));
  reasons.push(...ghWrites.map(ghRefusalOf));
  reasons.push(...calls.flatMap(({ call }) => (call.kind === 'owner' ? [ownerRefusalOf(call.action)] : [])));
  reasons.push(...opaqueOwner.map((run) => ownerRefusalOf(ownerActionOf(run.args))));
  const roots = new Set<string>();
  for (const { call, client, at } of calls) {
    if (call.kind === 'review' || call.kind === 'plain' || call.kind === 'issue') {
      const placed = await clientRootOf(client, at, env, call.kind === 'issue' ? 'issue' : 'exec');
      if (placed.kind === 'refused') {
        reasons.push(placed.why);
      } else {
        roots.add(placed.root);
      }
    }
  }
  for (const root of roots) {
    const refusal = clientRefusalOf(await env.checkClient(root), root, env.installs);
    if (refusal !== undefined) {
      reasons.push(refusal);
    }
  }
  const acting = calls.flatMap(({ call }) => (call.kind === 'review' ? [reviewActing(call)] : call.kind === 'issue' ? [issueActing(call)] : []));
  if (acting.length > 0) {
    const identity = await env.identity();
    reasons.push(...acting.map((call) => actingRefusalOf(call, identity)).filter((reason) => reason !== undefined));
  }
  return reasons.length === 0 ? '' : holdBackOutput('deny', `teamrig exec guard: ${[...new Set(reasons)].join(' ')}`, env.hookAsks);
}
