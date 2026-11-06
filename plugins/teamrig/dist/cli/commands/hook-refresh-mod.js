import { claudeProjectsDir, findTranscript } from "../../budget/discover.js";
import { isNonNegativeInteger, isRecord, stringField } from "../../core/guards.js";
import { ENV, KIT_NAME } from "../../core/home.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { inBookedMeeting, MeetingSchedule } from "../../meeting/schedule.js";
import { inMeeting, MeetingStore } from "../../meeting/state.js";
import { decideCompact, decideMidTurn, handoverHashOf } from "../../refresh/decide.js";
import { readRunningWork } from "../../refresh/running.js";
import { RefreshStore } from "../../refresh/store.js";
import { readContextEstimate } from "../../refresh/usage.js";
import { noPositionals } from "../args.js";
import { EXIT } from "../runtime.js";
import { hookScopeOf, parseJson } from "./hook-input.js";
const OFF = { kind: 'wait', nextAt: null };
const GO = { kind: 'go' };
function answer(runtime, value) {
    runtime.out.stdout(JSON.stringify(value));
    return EXIT.ok;
}
function countOf(payload, key) {
    const value = payload[key];
    return isNonNegativeInteger(value) ? value : undefined;
}
/**
 * The facts a due refresh or notice reads: the handover as it is now (so `refresh --ready` can tell a new one
 * from it), and the background work still running in `transcript`, which a fresh start must wait for.
 */
export async function dueFactsAt(runtime, store, id, transcript) {
    return {
        handoverHash: handoverHashOf(await store.handover(id)),
        running: transcript === undefined ? 0 : await readRunningWork(runtime.files, transcript, runtime.clock.now()),
    };
}
/**
 * Whether the session is in an open owner meeting, which holds its refresh (`meetingHolds`): the lead's daily meeting,
 * or a booked one it is met in or joins (`inBookedMeeting`, T2111). Two small files, the second read only when the
 * first holds nothing.
 */
export async function inMeetingNow(runtime, scope) {
    const now = runtime.clock.now();
    if (inMeeting(await new MeetingStore(runtime.files, scope.kit.paths.meeting).read(), scope.id, now)) {
        return true;
    }
    return inBookedMeeting((await new MeetingSchedule(runtime.files, scope.kit.paths.meetings).read()).meetings, scope.id, now);
}
/** The tab's own transcript: the mod knows its Claude Code session and project, not where Claude Code keeps it. */
async function transcriptOf(runtime, payload) {
    const claudeSession = sessionIdOf(payload);
    if (claudeSession === null) {
        return undefined;
    }
    const project = runtime.env[ENV.claudeProjectDir] ?? stringField(payload, 'cwd');
    return findTranscript(runtime.transcripts, claudeProjectsDir(runtime.env, runtime.userHome), project, claudeSession);
}
function askContextOf(runtime, scope, store) {
    const { config, roster, id } = scope;
    return {
        settings: config.refresh,
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
 * stdin: `{session_id, cwd, tokens}`, `tokens` the context the last reply read.
 */
export async function refreshMid(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    if (!isRecord(payload)) {
        return answer(runtime, OFF);
    }
    const tokens = countOf(payload, 'tokens');
    const scope = tokens === undefined ? undefined : await hookScopeOf(runtime, payload);
    if (tokens === undefined || scope === undefined || !scope.config.refresh.enabled) {
        return answer(runtime, OFF);
    }
    const store = new RefreshStore(runtime.files, scope.kit.paths);
    const state = await store.state(scope.id);
    const context = askContextOf(runtime, scope, store);
    const meeting = await inMeetingNow(runtime, scope);
    const first = decideMidTurn(state, context, { tokens, meeting, due: undefined });
    const decision = first.kind === 'measure'
        ? decideMidTurn(state, context, { tokens, meeting, due: await dueFactsAt(runtime, store, scope.id, await transcriptOf(runtime, payload)) })
        : first;
    switch (decision.kind) {
        case 'ask':
            // Written before it is answered: an ask whose state is not recorded would be asked again at every tool.
            await store.setState(scope.id, decision.state);
            return answer(runtime, { kind: 'ask', text: decision.reason, nextAt: decision.nextAt });
        case 'none':
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
export async function compactCheck(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    if (!isRecord(payload)) {
        return answer(runtime, GO);
    }
    const tokens = countOf(payload, 'tokens');
    const window = countOf(payload, 'window');
    const scope = tokens === undefined || window === undefined ? undefined : await hookScopeOf(runtime, payload);
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
export async function preCompact(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    if (!isRecord(payload) || stringField(payload, 'trigger') !== 'auto') {
        return EXIT.ok;
    }
    const transcript = stringField(payload, 'transcript_path');
    const scope = transcript === undefined ? undefined : await hookScopeOf(runtime, payload);
    if (transcript === undefined || scope === undefined) {
        return EXIT.ok;
    }
    const tokens = await readContextEstimate(runtime.files, transcript);
    const state = await new RefreshStore(runtime.files, scope.kit.paths).state(scope.id);
    const decision = tokens === undefined ? GO : decideCompact(state, { settings: scope.config.refresh, command: KIT_NAME }, { tokens, window: undefined });
    if (decision.kind === 'skip') {
        runtime.out.stdout(JSON.stringify({ decision: 'block', reason: decision.reason }));
    }
    return EXIT.ok;
}
