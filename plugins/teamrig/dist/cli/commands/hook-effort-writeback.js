import { launchOf } from "../../config/launch.js";
import { errorMessage, isRecord, stringField } from "../../core/guards.js";
import { KIT_NAME } from "../../core/home.js";
import { effortChangeLine, effortChangeText, effortWriteback, withLaunchEffort, WritebackMarksStore } from "../../effort/writeback.js";
import { payloadEffortOf } from "../../hooks/model-check.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { noPositionals } from "../args.js";
import { postToHolder, sessionNameOn } from "../holder-team.js";
import { checkedNextConfig, configFileJson, configLockOf, requireConfig, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
import { leadAboveOf } from "../tree.js";
import { hookScopeOf, parseJson } from "./hook-input.js";
/** The backup name of a config before a typed `/effort` of session `id` was written to it. */
export function effortBackupName(id) {
    return `config.effort-${id}`;
}
/**
 * Sets only `launch.<id>.effort` in the team config file, read afresh under the config lock, so a change another
 * command just wrote stays; undefined when the file already gives the session that level. Refused, nothing written,
 * for a config with a problem or from a newer teamrig, or when the result would not load.
 */
async function writeLaunchEffort(runtime, scope, level) {
    const config = requireConfig(scope.kit, runtime, 'write');
    return configLockOf(runtime, scope.kit, config).run(async (writer) => {
        const file = await configFileJson(runtime, scope.kit.load.path);
        const from = launchOf(checkedNextConfig(file), scope.id).effort;
        if (from === level) {
            return undefined;
        }
        const next = withLaunchEffort(file, scope.id, level);
        const updated = checkedNextConfig(next);
        const backup = await writer.write(next, effortBackupName(scope.id));
        return { written: { from, to: level, backup }, config: updated };
    });
}
/** Who hears of a session's write-back: the team's lead, and for the lead itself the lead above it (a root lead itself). */
async function writebackReaderOf(runtime, scope) {
    const team = scope.kit.paths.team;
    const lead = { team, id: scope.config.roles.lead };
    return scope.id === lead.id ? ((await leadAboveOf(runtime, team, scope.config)) ?? lead) : lead;
}
/** Tells the session's leader of a write-back; the line for the user when it was not told. */
async function tellLeader(runtime, scope, change) {
    const { kit, config, id } = scope;
    const team = kit.paths.team;
    const to = await writebackReaderOf(runtime, scope);
    const text = effortChangeText(sessionNameOn(to.team, team, id), team, change, teamZone(config, runtime));
    const problem = await postToHolder(runtime, { kit, config }, to, { from: KIT_NAME, text }).catch(errorMessage);
    return problem === undefined ? undefined : `INBOX ${sessionNameOn(team, to.team, to.id)}: not told of the effort change: ${problem}`;
}
/**
 * Logs a write-back and tells the session's leader; the lines for the user, each step that failed included. The
 * level is written by then, so neither failure undoes it or stops the other step.
 */
async function reportWriteback(runtime, scope, claude, change) {
    const { kit, id } = scope;
    const name = scope.roster.nameOf(id) ?? id;
    const { written } = change;
    const lines = [`EFFORT ${name}: the typed /effort ${written.to} is now its launch effort in the ${kit.paths.team} config (was ${written.from ?? 'unset'}); a restore or restart opens it at ${written.to}`];
    const unlogged = await runtime.files.append(kit.paths.effortChanges, effortChangeLine(runtime.clock.now(), id, claude, change)).then(() => undefined, (error) => `EFFORT ${name}: the change is not in the effort change log: ${errorMessage(error)}`);
    const untold = await tellLeader(runtime, scope, change).catch((error) => `INBOX: the leader of ${name} is not told of the effort change: ${errorMessage(error)}`);
    return [...lines, ...[unlogged, untold].filter((line) => line !== undefined)];
}
/**
 * Writes the level of an `/effort` the user typed in the session back to its `launch` entry (effortWriteback, T2441),
 * at the end of a turn (Stop) and when the tab closes (SessionEnd), then logs it and tells its leader. Nothing is
 * looked at without a Claude Code session id; a log line or inbox line that fails leaves the written config and is
 * shown to the user.
 */
export async function effortWritebackOf(runtime, scope, payload) {
    const claude = sessionIdOf(payload);
    if (claude === null) {
        return { config: scope.config, lines: [] };
    }
    let updated = scope.config;
    const deps = {
        files: runtime.files,
        clock: runtime.clock,
        marks: new WritebackMarksStore(runtime.files, scope.kit.paths.effortWriteback),
        configChangedAt: () => runtime.files.modifiedAt(scope.kit.load.path),
        write: async (level) => {
            const done = await writeLaunchEffort(runtime, scope, level);
            updated = done?.config ?? updated;
            return done?.written;
        },
    };
    const change = await effortWriteback(deps, {
        id: scope.id,
        claude,
        transcript: stringField(payload, 'transcript_path'),
        running: payloadEffortOf(payload),
        config: launchOf(scope.config, scope.id).effort,
    });
    if (change === undefined) {
        return { config: updated, lines: [] };
    }
    return { config: updated, lines: await reportWriteback(runtime, scope, claude, change) };
}
/**
 * `hook effort-writeback`, at SessionEnd: a session's `/effort` typed and then closed with no turn after it still
 * reaches its `launch` entry (effortWritebackOf). It prints nothing, Claude Code shows nothing at SessionEnd, and
 * never fails the hook: an error leaves the marks, so the session's next look retries.
 */
export async function effortWritebackHook(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    if (isRecord(payload)) {
        const scope = await hookScopeOf(runtime, payload).catch(() => undefined);
        if (scope !== undefined) {
            await effortWritebackOf(runtime, scope, payload).catch(() => undefined);
        }
    }
    return EXIT.ok;
}
