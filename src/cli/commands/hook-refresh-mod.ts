import { claudeProjectsDir, findTranscript } from '../../budget/discover.ts';
import { sessionRefreshOf } from '../../config/refresh.ts';
import { isNonNegativeInteger, type JsonRecord } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { inBookedMeeting, MeetingSchedule } from '../../meeting/schedule.ts';
import { inMeeting, MeetingStore } from '../../meeting/state.ts';
import { decideCompact, decideMidTurn, handoverHashOf, type AskContext, type CompactDecision, type DueFacts } from '../../refresh/decide.ts';
import { readRunningWork } from '../../refresh/running.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { readContextEstimate } from '../../refresh/usage.ts';
import { contextSourceIfTold, identityOf, transcriptsIfKept } from '../host.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { hookScopeOf, readHookInput, readModRequest, writeReply, type HookOrigin, type SessionScope } from './hook-input.ts';

/**
 * What `hook refresh-mid` answers the plugin's mod, one JSON line: the ask to add after the tool's result, or
 * none; with the context size to check again at (`nextAt`; null: only at the mod's recheck, as when refresh is off,
 * the tab is no team session, or its handover is marked ready and not yet announced).
 */
export type MidTurnAnswer =
  | { readonly kind: 'ask'; readonly text: string; readonly nextAt: number }
  | { readonly kind: 'wait'; readonly nextAt: number | null };

const OFF: MidTurnAnswer = { kind: 'wait', nextAt: null };
const GO: CompactDecision = { kind: 'go' };

function answer(runtime: CliRuntime, value: MidTurnAnswer | CompactDecision): ExitCode {
  runtime.out.stdout(JSON.stringify(value));
  return EXIT.ok;
}

function countOf(fields: JsonRecord, key: string): number | undefined {
  const value = fields[key];
  return isNonNegativeInteger(value) ? value : undefined;
}

/**
 * The facts a due refresh or notice reads: the handover as it is now (so a turn end or `refresh --ready` can tell
 * a new one from it, and the turn end can take a new one as ready), and the background work still running in
 * `transcript`, which a fresh start must wait for.
 */
export async function dueFactsAt(runtime: CliRuntime, store: RefreshStore, id: string, transcript: string | undefined): Promise<DueFacts> {
  const handover = await store.handover(id);
  // A host that keeps no transcript teamrig can read shows no running work, as a missing transcript shows none.
  const reader = transcriptsIfKept(runtime);
  return {
    handoverHash: handoverHashOf(handover),
    handover,
    running: transcript === undefined || reader === undefined ? 0 : await readRunningWork(reader, runtime.files, transcript, runtime.clock.now()),
  };
}

/**
 * Whether the session is in an open owner meeting, which holds its refresh (`meetingHolds`): the lead's daily meeting,
 * or a booked one it is met in or joins (`inBookedMeeting`, T2111). Two small files, the second read only when the
 * first holds nothing.
 */
export async function inMeetingNow(runtime: CliRuntime, scope: Pick<SessionScope, 'kit' | 'id'>): Promise<boolean> {
  const now = runtime.clock.now();
  if (inMeeting(await new MeetingStore(runtime.files, scope.kit.paths.meeting).read(), scope.id, now)) {
    return true;
  }
  return inBookedMeeting((await new MeetingSchedule(runtime.files, scope.kit.paths.meetings).read()).meetings, scope.id, now);
}

/** The tab's own transcript: the mod knows its Claude Code session and project, not where Claude Code keeps it. */
async function transcriptOf(runtime: CliRuntime, origin: HookOrigin): Promise<string | undefined> {
  if (origin.session === undefined) {
    return undefined;
  }
  const project = identityOf(runtime).projectDir ?? origin.cwd;
  return findTranscript(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), project, origin.session);
}

function askContextOf(runtime: CliRuntime, scope: SessionScope, store: RefreshStore): AskContext {
  const { config, roster, id } = scope;
  return {
    settings: sessionRefreshOf(config, id),
    now: new Date(runtime.clock.now()).toISOString(),
    session: { id, team: scope.kit.paths.team, name: roster.nameOf(id) ?? id },
    handoverPath: store.handoverPath(id),
    command: KIT_NAME,
  };
}

/**
 * Run by the plugin's mod after a tool's result within a turn, once the context reached the size it was told to
 * check again at: asks the session to write its handover within this turn once its context reached the refresh
 * threshold (`decideMidTurn`), so a long turn refreshes before Claude Code compacts it. The ask is recorded
 * before it is answered, so the turn's end asks again only when the handover is not written by then. The
 * running work, which takes the transcript's last 8 MiB, is read only once the context is past the size.
 * stdin: `{session_id, cwd, tokens, window?}`, `tokens` the context the last reply read, `window` the context window
 * Claude Code reports, which raises the threshold on a large one.
 */
export async function refreshMid(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const request = await readModRequest(runtime);
  if (request === undefined) {
    return answer(runtime, OFF);
  }
  const { event, fields } = request;
  const tokens = countOf(fields, 'tokens');
  const scope = tokens === undefined ? undefined : await hookScopeOf(runtime, event);
  if (tokens === undefined || scope === undefined || !scope.config.refresh.enabled) {
    return answer(runtime, OFF);
  }
  // The window Claude Code reports, which tells a large one apart; a mod from before it sends none.
  const window = countOf(fields, 'window');
  const store = new RefreshStore(runtime.files, scope.kit.paths);
  const state = await store.state(scope.id);
  const context = askContextOf(runtime, scope, store);
  const meeting = await inMeetingNow(runtime, scope);
  const first = decideMidTurn(state, context, { tokens, window, meeting, due: undefined });
  const decision =
    first.kind === 'measure'
      ? decideMidTurn(state, context, { tokens, window, meeting, due: await dueFactsAt(runtime, store, scope.id, await transcriptOf(runtime, event)) })
      : first;
  switch (decision.kind) {
    case 'ask':
      // Written before it is answered: an ask whose state is not recorded would be asked again at every tool.
      await store.setState(scope.id, decision.state);
      return answer(runtime, { kind: 'ask', text: decision.reason, nextAt: decision.nextAt });
    case 'none':
      if (decision.state !== undefined) {
        // A fresh start's first measure, its baseline, or the window the session showed.
        await store.setState(scope.id, decision.state);
      }
      return answer(runtime, { kind: 'wait', nextAt: decision.nextAt });
    case 'measure':
      // Asked only without the due facts, which the second decision has.
      return answer(runtime, OFF);
  }
}

/**
 * Run by the plugin's mod before Claude Code compacts the conversation, at its threshold or for the summary it
 * computes ahead: `skip`, with the line that says why, while the session's handover is asked for or written and
 * its fresh start follows this turn, so the compaction waits until `refresh.compactCeilingTokens`
 * (`decideCompact`); else `go`, on any input it cannot read too. stdin: `{session_id, cwd, tokens, window}`.
 */
export async function compactCheck(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const request = await readModRequest(runtime);
  if (request === undefined) {
    return answer(runtime, GO);
  }
  const { event, fields } = request;
  const tokens = countOf(fields, 'tokens');
  const window = countOf(fields, 'window');
  const scope = tokens === undefined || window === undefined ? undefined : await hookScopeOf(runtime, event);
  if (tokens === undefined || window === undefined || scope === undefined) {
    return answer(runtime, GO);
  }
  const store = new RefreshStore(runtime.files, scope.kit.paths);
  return answer(runtime, decideCompact(await store.state(scope.id), { settings: scope.config.refresh, command: KIT_NAME }, { tokens, window }));
}

/**
 * Claude Code's classic PreCompact hook: `compactCheck`'s hold where the mod's never runs, on a host whose managed
 * mods seat one first that sends `session.compact` on past the user's mods (T2015). The same decision for a
 * compaction Claude Code runs on its own (trigger `auto`; a `/compact` the user typed goes), on the context
 * estimated from the transcript (`readContextEstimate`) and no window, which this hook is not told. A hold answers
 * `{decision: 'block', reason}`, a go prints nothing, both with exit 0: exit 2 blocks a compaction too, so this hook
 * never answers by a refusal. stdin: `{session_id, transcript_path, cwd, trigger}`.
 */
export async function preCompact(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { event } = await readHookInput(runtime);
  if (event === undefined || event.trigger !== 'auto') {
    return EXIT.ok;
  }
  const { transcript } = event;
  const scope = transcript === undefined ? undefined : await hookScopeOf(runtime, event);
  if (transcript === undefined || scope === undefined) {
    return EXIT.ok;
  }
  // No readable transcript or no meter, no estimate: the compaction goes, since a refusal here would block it.
  const source = contextSourceIfTold(runtime);
  const tokens = source === undefined ? undefined : await readContextEstimate(source, runtime.files, transcript);
  const state = await new RefreshStore(runtime.files, scope.kit.paths).state(scope.id);
  const decision = tokens === undefined ? GO : decideCompact(state, { settings: scope.config.refresh, command: KIT_NAME }, { tokens, window: undefined });
  if (decision.kind === 'skip') {
    writeReply(runtime, 'compact-start', { verdict: { kind: 'block', reason: decision.reason } });
  }
  return EXIT.ok;
}
