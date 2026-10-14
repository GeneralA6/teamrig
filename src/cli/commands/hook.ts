import { Roster } from '../../config/roster.ts';
import type { KitConfig } from '../../config/types.ts';
import { errorMessage, isRecord, stringField, type JsonRecord } from '../../core/guards.ts';
import { ENV, KIT_NAME } from '../../core/home.ts';
import { resolveTeam, type TeamResolution } from '../../core/team.ts';
import { reminderFor, sessionIdOf } from '../../inbox/inbox.ts';
import { indexMarks } from '../../inbox/marks.ts';
import { commitsOf, protectedBranchesOf, pushGuardOutput } from '../../hooks/push-guard.ts';
import { sessionStartContext, sessionStartOutput, type SessionStartInput } from '../../hooks/session-start.ts';
import { stopOutput } from '../../hooks/stop.ts';
import { adoptTitle, promptNote, sessionStartNote, type TitleOutcome } from '../../names/detect.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { sessionTitleOf } from '../../names/title.ts';
import { decideStart, decideStop, handoverHashOf, type BoundaryFacts, type StopContext } from '../../refresh/decide.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { readContextTokens } from '../../refresh/usage.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, renameDepsOf, rosterOf, teamFolders, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { inboxDepsOf } from './inbox.ts';

/**
 * Claude Code hooks. Each reads the hook's JSON from stdin and prints only what Claude Code
 * should act on, and never refuses: a refusal exits 2, which would block the tool call. A plugin
 * enabled for the user fires in every project, so outside a team's projects each hook prints
 * nothing at all.
 */

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The payload's folder first: Claude Code may start the hook process somewhere else. */
function hookTeam(payload: unknown, runtime: CliRuntime): Promise<TeamResolution> {
  const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
  return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd, runtime.cwd]));
}

/** PreToolUse on Bash and PowerShell: asks before a push to a protected branch, refuses a force-push of one. */
export async function pushGuard(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const found = await hookTeam(payload, runtime);
  if (found.kind === 'none') {
    return EXIT.ok;
  }
  // A broken pointer, or a config that cannot even be opened, keeps the default branches: neither turns the guard off.
  const load =
    found.kind === 'team'
      ? await openKit(runtime, found.team).then(
          (kit) => kit.load,
          () => undefined,
        )
      : undefined;
  const output = pushGuardOutput(payload, {
    cwd: runtime.cwd,
    home: runtime.userHome,
    repo: runtime.git,
    protectedBranches: protectedBranchesOf(load),
    commits: commitsOf(load),
    commitLog: runtime.commitLog,
  });
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/** `$TEAMRIG_SESSION` as Claude Code passed it to the hook; undefined when unset or blank. */
function envSession(runtime: CliRuntime): string | undefined {
  const session = runtime.env[ENV.session]?.trim();
  return session === '' ? undefined : session;
}

/**
 * The team session a hook runs for: `$TEAMRIG_SESSION` when it is set (an id or any name the
 * session has had), else the area this Claude Code session last read its inbox as.
 */
async function teamSessionOf(runtime: CliRuntime, kit: Kit, roster: Roster, claudeSession: string | null): Promise<string | undefined> {
  const session = envSession(runtime);
  if (session !== undefined) {
    const found = roster.lookup(session);
    return found.ok ? found.id : undefined;
  }
  if (claudeSession === null) {
    return undefined;
  }
  const { marks } = await inboxDepsOf(runtime, kit.paths).marks.read();
  const area = indexMarks(marks).areaBySession.get(claudeSession);
  return area !== undefined && roster.ids.includes(area) ? area : undefined;
}

/**
 * A Claude Code rename (`--name`, `/rename`) of the session becomes its new team name: recorded in
 * the rename log, never by moving data. It never throws, so the hook always answers; a failure is
 * retried on the next prompt.
 */
async function titleOutcome(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: unknown): Promise<TitleOutcome> {
  try {
    const title = await sessionTitleOf(payload, runtime.files);
    if (title === undefined) {
      return { kind: 'none' };
    }
    const roster = await rosterOf(runtime, kit, config);
    const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    return id === undefined ? { kind: 'none' } : await adoptTitle(renameDepsOf(runtime, kit, config), roster, id, title);
  } catch (error) {
    return { kind: 'failed', error: errorMessage(error) };
  }
}

/** UserPromptSubmit: notes a Claude Code rename of the session, then one line when its inbox has unread lines, or its team pointer is broken. */
export async function inboxReminder(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const claudeSession = sessionIdOf(payload);
  if (claudeSession === null) {
    return EXIT.ok;
  }
  const found = await hookTeam(payload, runtime);
  switch (found.kind) {
    case 'none':
      return EXIT.ok;
    case 'broken':
      runtime.out.stdout(`${KIT_NAME}: no team, so no inbox reminder: ${found.from} ${found.problem}`);
      return EXIT.ok;
    case 'team':
      break;
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded') {
    return EXIT.ok;
  }
  const note = promptNote(await titleOutcome(runtime, kit, kit.load.config, payload), KIT_NAME);
  if (note !== undefined) {
    runtime.out.stdout(note);
  }
  // Found like a rename: `$TEAMRIG_SESSION` first, so a session is reminded before its first `inbox read`.
  const session = await teamSessionOf(runtime, kit, await rosterOf(runtime, kit, kit.load.config), claudeSession);
  const line = session === undefined ? undefined : await reminderFor(inboxDepsOf(runtime, kit.paths), session, KIT_NAME);
  if (line !== undefined) {
    runtime.out.stdout(line);
  }
  return EXIT.ok;
}

type TeamParts = Pick<SessionStartInput, 'teamRules' | 'renames' | 'titleNote' | 'refreshNote'>;

/**
 * A loaded team's rules.md and rename log, after recording a Claude Code rename of the session, and
 * the pointer to its handover after a refresh.
 */
async function teamPartsOf(runtime: CliRuntime, kit: Kit, config: KitConfig, payload: unknown): Promise<TeamParts> {
  const titleNote = sessionStartNote(await titleOutcome(runtime, kit, config, payload));
  const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
  const refreshNote = await refreshNoteOf(runtime, kit, config, new Roster(config, kit.paths.team, renames), payload);
  const text = await runtime.files.read(kit.paths.teamRules);
  return { teamRules: text === undefined ? undefined : { path: kit.paths.teamRules, text }, renames, titleNote, refreshNote };
}

/**
 * A fresh start (`/clear`, a new process) after the session's handover was marked ready: the note
 * that points it at the handover, given once. A start that keeps the old context (compact, resume)
 * leaves the handover waiting. It never throws, so the session always gets its rules.
 */
async function refreshNoteOf(runtime: CliRuntime, kit: Kit, config: KitConfig, roster: Roster, payload: unknown): Promise<string | undefined> {
  try {
    const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
    if (id === undefined) {
      return undefined;
    }
    const store = new RefreshStore(runtime.files, kit.paths);
    const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
    const now = new Date(runtime.clock.now()).toISOString();
    const decision = decideStart(await store.state(id), source, config.refresh, store.handoverPath(id), now);
    if (decision.kind === 'none') {
      return undefined;
    }
    await store.setState(id, decision.state);
    await store.clearRequest(id);
    return decision.note;
  } catch (error) {
    return `${KIT_NAME} could not check for a refresh handover (${errorMessage(error)}); if you wrote one before a /clear, read it first.`;
  }
}

/**
 * The refresh facts of a boundary: the lead's request, the context size from the transcript's
 * tail, and the handover as it is now (so `refresh --ready` can tell a new one from it).
 */
async function boundaryFactsOf(runtime: CliRuntime, roster: Roster, store: RefreshStore, id: string, payload: JsonRecord): Promise<BoundaryFacts> {
  const request = await store.request(id);
  const transcript = stringField(payload, 'transcript_path');
  return {
    requestedBy: request === undefined ? undefined : (roster.nameOf(request.by) ?? request.by),
    tokens: transcript === undefined ? undefined : await readContextTokens(runtime.files, transcript),
    handoverHash: handoverHashOf(await store.handover(id)),
  };
}

/**
 * What the Stop hook prints for this turn's end; '' outside a team, without a session, with refresh
 * off, or for input that is not a hook payload (which would judge a boundary without its transcript).
 */
async function stopOutputOf(runtime: CliRuntime, payload: unknown): Promise<string> {
  if (!isRecord(payload)) {
    return '';
  }
  const found = await hookTeam(payload, runtime);
  if (found.kind !== 'team') {
    return '';
  }
  const kit = await openKit(runtime, found.team);
  if (kit.load.status !== 'loaded' || !kit.load.config.refresh.enabled) {
    return '';
  }
  const { config } = kit.load;
  const roster = await rosterOf(runtime, kit, config);
  const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
  if (id === undefined) {
    return '';
  }
  const store = new RefreshStore(runtime.files, kit.paths);
  const state = await store.state(id);
  const context: StopContext = {
    stopHookActive: payload['stop_hook_active'] === true,
    settings: config.refresh,
    now: new Date(runtime.clock.now()).toISOString(),
    session: { id, name: roster.nameOf(id) ?? id },
    handoverPath: store.handoverPath(id),
    command: KIT_NAME,
  };
  const first = decideStop(state, context);
  const decision = first.kind === 'measure' ? decideStop(state, context, await boundaryFactsOf(runtime, roster, store, id, payload)) : first;
  switch (decision.kind) {
    case 'write':
    case 'block':
    case 'notice':
      // Written before anything is printed: a block whose state is not recorded would ask again at every stop.
      await store.setState(id, decision.state);
      break;
    case 'none':
    case 'measure':
      break;
  }
  return stopOutput(decision);
}

/**
 * Stop, at the end of every turn: after the session finished a task (`set done`), asks for its
 * handover once when its context reached the team's threshold or the lead asked, then tells the user
 * once that it waits for /clear. A turn with nothing to judge reads only small files and prints
 * nothing. It never blocks on an error: a refresh is a convenience, and the next stop tries again.
 */
export async function stop(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const output = await stopOutputOf(runtime, payload).catch(() => '');
  if (output !== '') {
    runtime.out.stdout(output);
  }
  return EXIT.ok;
}

/** SessionStart: the core rules from the team config, who the session is (and, after a refresh, its handover), and the team's rules.md. */
export async function sessionStart(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const found = await hookTeam(payload, runtime);
  switch (found.kind) {
    case 'none':
      return EXIT.ok;
    case 'broken':
      runtime.out.stdout(sessionStartOutput(`${KIT_NAME}: no team, so no team rules: ${found.from} ${found.problem}`));
      return EXIT.ok;
    case 'team':
      break;
  }
  const kit = await openKit(runtime, found.team);
  const parts: TeamParts =
    kit.load.status === 'loaded'
      ? await teamPartsOf(runtime, kit, kit.load.config, payload)
      : { teamRules: undefined, renames: [], titleNote: undefined, refreshNote: undefined };
  const context = sessionStartContext({ team: found.team, load: kit.load, ...parts, session: envSession(runtime), command: KIT_NAME });
  runtime.out.stdout(sessionStartOutput(context));
  return EXIT.ok;
}
