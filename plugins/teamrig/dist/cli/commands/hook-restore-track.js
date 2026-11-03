import { isRecord, stringField } from "../../core/guards.js";
import { ENV, resolveKitHome } from "../../core/home.js";
import { ID_PATTERN } from "../../core/ids.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { dayProbePath, dayProbeReleaseLine } from "../../restore/day-probe.js";
import { DayProbeStore } from "../../restore/day-probe-store.js";
import { apiGaveUpLine, apiRetriesSpentOn } from "../../restore/api-error.js";
import { applyEvent } from "../../restore/entry.js";
import { AUTH_FAILED, LOGIN_LOCK, loginLogLine, loginMarkerPath } from "../../restore/login.js";
import { LoginStore } from "../../restore/login-store.js";
import { RestoreRegistry, restoreLogPath, restoreSessionsDir } from "../../restore/registry.js";
import { TURN_TAIL_BYTES, turnErrorOf } from "../../restore/turn-error.js";
import { noPositionals } from "../args.js";
import { fileLockOf } from "../file-locks.js";
import { loginPageLogLine, loginPageOf, sendLoginPage } from "../login-page.js";
import { EXIT } from "../runtime.js";
import { parseJson } from "./hook-input.js";
/**
 * The event a hook payload reports; undefined for one the tracker skips. A compaction's SessionStart
 * (`source: compact`) is skipped: it comes mid-turn in the same process, and must not mark a working
 * session ready.
 */
export function trackEventOf(payload) {
    switch (stringField(payload, 'hook_event_name')) {
        case 'SessionStart':
            return stringField(payload, 'source') === 'compact' ? undefined : { kind: 'start' };
        case 'UserPromptSubmit':
            return { kind: 'working' };
        case 'PostToolUse':
        case 'PostToolUseFailure':
            // A helper's tool call carries the helper's id (`agent_id`).
            return { kind: 'tool', mainThread: stringField(payload, 'agent_id') === undefined };
        case 'Stop':
            return { kind: 'ready' };
        case 'StopFailure':
            // A payload with no error is read from the transcript once, by `trackRestore` (`codedEvent`).
            return { kind: 'error', code: stringField(payload, 'error') };
        case 'SessionEnd':
            return { kind: 'end', reason: stringField(payload, 'reason') };
        default:
            return undefined;
    }
}
/** A non-empty value; undefined for an unset or blank one. */
function present(value) {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}
/** A team or session id from the environment; undefined unless it is one, so no other text reaches a command line. */
function envId(runtime, name) {
    const value = present(runtime.env[name]);
    return value !== undefined && ID_PATTERN.test(value) ? value : undefined;
}
/**
 * Writes the event into its session's restore entry, or removes the entry at an end the person chose. A turn that
 * failed on a transient API error with every retry spent (src/restore/api-error.ts) is logged as left for the person.
 */
async function trackEntry(event, facts, runtime, kitHome) {
    const registry = new RestoreRegistry(runtime.files, restoreSessionsDir(kitHome));
    const change = applyEvent(await registry.read(facts.claudeSession), event, facts);
    switch (change.kind) {
        case 'write': {
            await registry.write(change.entry);
            const spentOn = event.kind === 'error' ? apiRetriesSpentOn(change.entry) : undefined;
            if (spentOn !== undefined) {
                await runtime.files.append(restoreLogPath(kitHome), `${new Date(facts.at).toISOString()} ${apiGaveUpLine(tabLabelOf(facts), spentOn)}\n`);
            }
            return;
        }
        case 'remove':
            await registry.remove(facts.claudeSession);
            return;
        case 'none':
            return;
    }
}
/**
 * The event with a failed turn's error read from the transcript when the payload named none
 * (src/restore/turn-error.ts); a transcript that cannot be read names none, and never keeps the entry from its update.
 */
async function codedEvent(payload, event, facts, runtime) {
    const { transcriptPath } = facts;
    if (event.kind !== 'error' || event.code !== undefined) {
        return event;
    }
    const tailOf = async () => (transcriptPath === undefined ? undefined : runtime.files.readTail(transcriptPath, TURN_TAIL_BYTES));
    return { kind: 'error', code: await turnErrorOf(payload, tailOf).catch(() => undefined) };
}
/** The login event a turn end reports: a good one answered, a failed one failed on the login; undefined for any other. */
function loginEventOf(event, facts) {
    const { claudeSession, at } = facts;
    switch (event.kind) {
        case 'ready':
            return { kind: 'answered', claudeSession, at };
        case 'error':
            return event.code === AUTH_FAILED ? { kind: 'auth-failed', claudeSession, at } : undefined;
        default:
            return undefined;
    }
}
/** How the restore log names a tab: its team and session when `teamrig launch` started it, and its Claude session. */
function tabLabelOf(facts) {
    return facts.team === undefined || facts.session === undefined ? facts.claudeSession : `${facts.team}/${facts.session} (${facts.claudeSession})`;
}
/**
 * The page a failure of this tab would send: only a tab of a team, whose config or a team's above it names a page
 * webhook. A config that cannot be read pages no one and keeps the marker from no update.
 */
async function pageOf(event, facts, runtime) {
    if (event.kind !== 'auth-failed' || facts.team === undefined) {
        return undefined;
    }
    return loginPageOf(runtime, facts.team, facts.session, event.at).catch(() => undefined);
}
/**
 * Follows the login through turn ends (src/restore/login.ts); each change with a note goes to the restore log. The
 * failure that claims an expiry's page posts it to the owner outside the marker's lock, a slow chat holding no other
 * tab, and gives the claim back when the post fails, so the next failure pages.
 */
async function trackLogin(event, facts, runtime, kitHome) {
    const loginEvent = loginEventOf(event, facts);
    if (loginEvent === undefined) {
        return;
    }
    const page = await pageOf(loginEvent, facts, runtime);
    const path = loginMarkerPath(kitHome);
    const store = new LoginStore(runtime.files, path, fileLockOf(runtime, `${path}.lock`, LOGIN_LOCK));
    const { change, pageClaimed } = await store.apply(loginEvent, { claimPage: page !== undefined });
    const log = restoreLogPath(kitHome);
    if (change.kind === 'write' && change.note !== undefined) {
        const line = loginLogLine(change.note, tabLabelOf(facts), change.marker);
        await runtime.files.append(log, `${new Date(facts.at).toISOString()} ${line}\n`);
    }
    if (!pageClaimed || page === undefined) {
        return;
    }
    const problem = await sendLoginPage(page, runtime);
    await runtime.files.append(log, `${new Date(runtime.clock.now()).toISOString()} ${loginPageLogLine(page, problem)}\n`);
    if (problem !== undefined) {
        await store.releasePage(loginEvent.at);
    }
}
/** The reply an event shows the login works by: a good turn end, or a tool end of the tab's own turn; undefined for any other. */
function dayProbeReplyOf(event, facts) {
    if (event.kind === 'ready') {
        return { kind: 'answered', tab: facts.claudeSession, at: facts.at };
    }
    return event.kind === 'tool' && event.mainThread ? { kind: 'tool', tab: facts.claudeSession, at: facts.at } : undefined;
}
/** Releases the day-start probe (src/restore/day-probe.ts) at a reply that shows the login works, and logs it. */
async function trackDayProbe(event, facts, runtime, kitHome) {
    const reply = dayProbeReplyOf(event, facts);
    if (reply === undefined) {
        return;
    }
    const path = dayProbePath(kitHome);
    const released = await new DayProbeStore(runtime.files, path, fileLockOf(runtime, `${path}.lock`, LOGIN_LOCK)).release(reply);
    if (released !== undefined) {
        await runtime.files.append(restoreLogPath(kitHome), `${new Date(facts.at).toISOString()} ${dayProbeReleaseLine(tabLabelOf(facts), reply, released)}\n`);
    }
}
/**
 * Records the event `payload` reports in its session's restore entry, at a turn's end in the login marker, and at a
 * reply in the day-start probe; a payload of no session or event it skips writes nothing. A marker or probe that
 * cannot be written (its lock busy) never keeps the entry from its update; an entry that cannot be written fails the
 * call once they are done.
 */
export async function trackRestore(payload, runtime) {
    const claudeSession = sessionIdOf(payload);
    const reported = isRecord(payload) ? trackEventOf(payload) : undefined;
    if (!isRecord(payload) || claudeSession === null || reported === undefined) {
        return;
    }
    const facts = {
        claudeSession,
        at: runtime.clock.now(),
        // The folder the session started in, which stays put through a `cd` or a worktree: the one to resume from.
        projectDir: present(runtime.env[ENV.claudeProjectDir]) ?? present(stringField(payload, 'cwd')),
        transcriptPath: present(stringField(payload, 'transcript_path')),
        entrypoint: present(runtime.env[ENV.claudeEntrypoint]),
        sessionKind: present(runtime.env[ENV.claudeSessionKind]),
        // Claude Code starts its hooks itself (exec form, no shell), so the hook's parent is the session's Claude Code.
        pid: runtime.sessionProcesses.parentPid,
        team: envId(runtime, ENV.team),
        session: envId(runtime, ENV.session),
    };
    const kitHome = resolveKitHome(runtime.env, runtime.userHome);
    const event = await codedEvent(payload, reported, facts, runtime);
    const login = trackLogin(event, facts, runtime, kitHome).catch(() => undefined);
    const dayProbe = trackDayProbe(event, facts, runtime, kitHome).catch(() => undefined);
    try {
        await trackEntry(event, facts, runtime, kitHome);
    }
    finally {
        await Promise.all([login, dayProbe]);
    }
}
/**
 * SessionStart, UserPromptSubmit, Stop, StopFailure and SessionEnd: records the session in the restore
 * registry (`<kit home>/restore/sessions`), in a team or not, so the restore after a reboot knows which tabs
 * it closed and what each was doing (a tool's end comes through `hook tool-end`). At a turn's end it also follows the
 * login (`<kit home>/restore/login.json`): which tabs a turn that ended on Login expired left stuck, and when a
 * good turn showed the login works again; the first failure of an expiry pages the owner through the webhook the
 * team's `alerts.pageWebhookFile` or `alerts.pageWebhookEnv` names. A good turn end also releases the day-start probe
 * (`<kit home>/restore/day-probe.json`), as does the probe tab's tool end. A turn that failed on a transient API error
 * after the wake check's last retry logs `api-error: gave up on <tab>` to the restore log. It prints nothing, and on any
 * error it exits 0 having written nothing: a tracker must never hold up a turn.
 */
export async function restoreTrack(args, runtime) {
    noPositionals(args);
    await trackRestore(parseJson(await runtime.readStdin()), runtime).catch(() => undefined);
    return EXIT.ok;
}
