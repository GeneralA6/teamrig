import { isRecord, stringField } from "../../core/guards.js";
import { ENV, resolveKitHome } from "../../core/home.js";
import { ID_PATTERN } from "../../core/ids.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { applyEvent } from "../../restore/entry.js";
import { RestoreRegistry, restoreSessionsDir } from "../../restore/registry.js";
import { noPositionals } from "../args.js";
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
            return { kind: 'error' };
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
/** Records the event `payload` reports in its session's restore entry; a payload of no session or event it skips writes nothing. */
export async function trackRestore(payload, runtime) {
    const claudeSession = sessionIdOf(payload);
    const event = isRecord(payload) ? trackEventOf(payload) : undefined;
    if (!isRecord(payload) || claudeSession === null || event === undefined) {
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
    const registry = new RestoreRegistry(runtime.files, restoreSessionsDir(resolveKitHome(runtime.env, runtime.userHome)));
    const change = applyEvent(await registry.read(claudeSession), event, facts);
    switch (change.kind) {
        case 'write':
            await registry.write(change.entry);
            return;
        case 'remove':
            await registry.remove(claudeSession);
            return;
        case 'none':
            return;
    }
}
/**
 * SessionStart, UserPromptSubmit, Stop, StopFailure and SessionEnd: records the session in the restore
 * registry (`<kit home>/restore/sessions`), in a team or not, so the restore after a reboot knows which tabs
 * it closed and what each was doing (a tool's end comes through `hook tool-end`). It prints nothing, and on any
 * error it exits 0 having written nothing: a tracker must never hold up a turn.
 */
export async function restoreTrack(args, runtime) {
    noPositionals(args);
    await trackRestore(parseJson(await runtime.readStdin()), runtime).catch(() => undefined);
    return EXIT.ok;
}
