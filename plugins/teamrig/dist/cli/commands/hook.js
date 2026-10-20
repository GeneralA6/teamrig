import { tmpdir } from 'node:os';
import { launchOf } from "../../config/launch.js";
import { Roster } from "../../config/roster.js";
import { errorMessage, isRecord, stringField } from "../../core/guards.js";
import { claudeConfigDir, claudeTempDir, KIT_NAME } from "../../core/home.js";
import { resolveTeam } from "../../core/team.js";
import { sessionIdOf } from "../../inbox/inbox.js";
import { boundPromptNote, boundStartNote, tabTitleFor } from "../../hooks/bind.js";
import { modelCheckLine, payloadEffortOf } from "../../hooks/model-check.js";
import { ModelNoticeStore } from "../../hooks/model-notices.js";
import { sendTargetOf } from "../../hooks/cold-send.js";
import { failedSendLine, failedSendOf, failedSendOutput } from "../../hooks/failed-send.js";
import { packageGuardOf, packageGuardOutput } from "../../hooks/package-guard.js";
import { hookAsksOf } from "../../hooks/permission.js";
import { secretGuardOf, secretGuardOutput } from "../../hooks/secret-guard.js";
import { secretRulesOf } from "../../secret-guard/rules.js";
import { commitsOf, protectedBranchesOf, pushGuardOutput, pushToProtectedOf, skipHooksOf } from "../../hooks/push-guard.js";
import { JsonlHintLog } from "../../hooks/hint-log.js";
import { promptOutput } from "../../hooks/prompt-output.js";
import { showsLiveTasks } from "../../hooks/live-tasks.js";
import { requirementsNoteOnce } from "../../hooks/requirements-note.js";
import { helperOf } from "../../hooks/helper-start.js";
import { sessionStartContext, sessionStartOutput } from "../../hooks/session-start.js";
import { stopModelNotices } from "../../hooks/stop-model.js";
import { leadStopLine, leadTallyOf } from "../../hooks/lead-boundary.js";
import { turnToolsOf } from "../../hooks/loop-nudge.js";
import { blockOutput, stopOutput } from "../../hooks/stop.js";
import { adoptTitle, promptNote, sessionStartNote } from "../../names/detect.js";
import { JsonlRenameLog } from "../../names/log.js";
import { TRANSCRIPT_TAIL_BYTES } from "../../names/title.js";
import { decideStart, decideStop, reaskGrowth, thousands, } from "../../refresh/decide.js";
import { carryLines, carryStartOf, readCarry } from "../../refresh/carry.js";
import { claudeProcessOf } from "../../refresh/restart.js";
import { RefreshStore } from "../../refresh/store.js";
import { readContextTokens } from "../../refresh/usage.js";
import { noPositionals } from "../args.js";
import { openKit, renameDepsOf, rosterOf, rulesClockOf, teamFolders, teamZone } from "../kit.js";
import { EXIT } from "../runtime.js";
import { loadTree } from "../tree.js";
import { bindAfterClear, bindHintOnce, bindTab, inboxLinesFor, readTitle } from "./hook-bind.js";
import { helperGateOutput, promptBudgetLine, stopBudgetLines } from "./hook-budget.js";
import { startAutoSync } from "./gh-auto.js";
import { coldSendHold } from "./hook-cold-send.js";
import { liveTasksNoteOf } from "./live-tasks.js";
import { droppedEditReasonOf } from "./hook-dropped-edit.js";
import { meetingHold } from "./hook-meeting.js";
import { armRestart, restartTargetOf } from "./hook-restart.js";
import { helperContextOf } from "./hook-helper-start.js";
import { dueFactsAt } from "./hook-refresh-mod.js";
import { envSession, hookScopeOf, leadOwnPaths, parseJson, sessionScopeOf, sessionTeam, startSessionOf, teamScopeOf, teamSessionOf } from "./hook-input.js";
import { tabStatusOn, tabTitleOf } from "./hook-tab-status.js";
import { logPrompt, logReply, logStart } from "./hook-turn-log.js";
import { keepWorkingReasonOf } from "./keep-working.js";
import { retireAskReasonOf } from "./retire-ask.js";
import { verifyByLinesOf, verifyNoteOf } from "./verify-queue.js";
/**
 * Claude Code hooks. Each reads the hook's JSON from stdin and prints only what Claude Code
 * should act on, and never refuses: a refusal exits 2, which would block the tool call. A plugin
 * enabled for the user fires in every project, so outside a team's projects each hook prints
 * nothing at all.
 */
/** The payload's folder first: Claude Code may start the hook process somewhere else. */
function hookTeam(payload, runtime) {
    const cwd = isRecord(payload) ? stringField(payload, 'cwd') : undefined;
    return resolveTeam(runtime.files, runtime.env, teamFolders(runtime.env, [cwd, runtime.cwd]));
}
/**
 * The config a guard hook reads, or undefined outside a team's projects, where the guard prints nothing. A broken
 * pointer, or a config that cannot even be opened, gives no load, so the guard keeps its defaults: neither turns it off.
 */
async function guardLoadOf(payload, runtime) {
    const found = await hookTeam(payload, runtime);
    if (found.kind === 'none') {
        return undefined;
    }
    const load = found.kind === 'team'
        ? await openKit(runtime, found.team).then((kit) => kit.load, () => undefined)
        : undefined;
    return { load };
}
/** PreToolUse on Bash and PowerShell: asks before a push to a protected branch, refuses a force-push of one. */
export async function pushGuard(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const guard = await guardLoadOf(payload, runtime);
    if (guard === undefined) {
        return EXIT.ok;
    }
    const { load } = guard;
    const output = pushGuardOutput(payload, {
        cwd: runtime.cwd,
        home: runtime.userHome,
        repo: runtime.git,
        protectedBranches: protectedBranchesOf(load),
        pushToProtected: pushToProtectedOf(load),
        commits: commitsOf(load),
        commitLog: runtime.commitLog,
        skipHooks: skipHooksOf(load),
        hookAsks: hookAsksOf(load),
    });
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
/**
 * PreToolUse on Bash and PowerShell: refuses, or asks about, a package runner that would fetch and run a package ad hoc,
 * and an install of a version the registry does not vouch for (too young, with an advisory, or not exact).
 */
export async function packageGuard(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const guard = await guardLoadOf(payload, runtime);
    if (guard === undefined) {
        return EXIT.ok;
    }
    const output = await packageGuardOutput(payload, {
        ...packageGuardOf(guard.load),
        cwd: runtime.cwd,
        home: runtime.userHome,
        files: runtime.files,
        registry: runtime.packageRegistry,
        clock: runtime.clock,
        hookAsks: hookAsksOf(guard.load),
    });
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
/** PreToolUse on Bash, PowerShell, Read and Grep: refuses, or asks about, a call that would print a secret into the conversation. */
export async function secretGuard(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const guard = await guardLoadOf(payload, runtime);
    if (guard === undefined) {
        return EXIT.ok;
    }
    const config = secretGuardOf(guard.load);
    const output = secretGuardOutput(payload, {
        cwd: runtime.cwd,
        rules: secretRulesOf(config, runtime.userHome, runtime.platform),
        secretReads: config.secretReads,
        hookAsks: hookAsksOf(guard.load),
    });
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
/**
 * A Claude Code rename (`--name`, `/rename`) of the session becomes its new team name: recorded in
 * the rename log, never by moving data. It never throws, so the hook always answers; a failure is
 * retried on the next prompt.
 */
async function titleOutcome(runtime, kit, config, payload, read) {
    if (read.kind === 'failed') {
        return { kind: 'failed', error: read.error };
    }
    const { title } = read;
    try {
        if (title === undefined) {
            return { kind: 'none' };
        }
        const roster = await rosterOf(runtime, kit, config);
        const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
        return id === undefined ? { kind: 'none' } : await adoptTitle(renameDepsOf(runtime, kit, config), roster, id, title);
    }
    catch (error) {
        return { kind: 'failed', error: errorMessage(error) };
    }
}
/**
 * A prompt typed while the automatic restart waits for the session to be idle cancels it, so the
 * session keeps its context; one line tells the model, with the context growth (`growth` tokens) that asks
 * again. None when no restart waits, or one is already ending the session.
 */
async function cancelledRestartLine(runtime, kit, id, growth) {
    const store = new RefreshStore(runtime.files, kit.paths);
    if ((await store.restart(id))?.phase !== 'pending') {
        return undefined;
    }
    await store.clearRestart(id);
    return `${KIT_NAME}: the user typed, so the automatic restart is cancelled and you keep this context; a new handover is asked at your next task end, or once your context grew ${thousands(growth)} more`;
}
/**
 * UserPromptSubmit: logs a team session's prompt for the task pane (hook-turn-log.ts), cancels a pending
 * automatic restart, binds a hand-started tab by its title, notes a Claude Code rename of the session, titles a
 * bound tab that has no title after its session (so a /clear keeps it bound), says once how to bind a tab that is
 * not bound, shows the session's new inbox lines and, once per level while it is past its daily budget and the
 * team is ahead of its pace line, tells the model to finish the step in hand; or one line when its team pointer
 * is broken.
 */
export async function inboxReminder(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const claudeSession = sessionIdOf(payload);
    if (claudeSession === null) {
        return EXIT.ok;
    }
    const found = await sessionTeam(payload, runtime);
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
    const { config } = kit.load;
    const title = await readTitle(runtime, payload);
    const own = { team: kit.paths.team, roster: await rosterOf(runtime, kit, config) };
    const binding = await bindTab(runtime, kit, own, claudeSession, title);
    const bound = boundPromptNote(binding.outcome, own, KIT_NAME);
    const renamed = promptNote(await titleOutcome(runtime, kit, config, payload, title), KIT_NAME);
    const hint = await bindHintOnce(runtime, kit, binding, claudeSession);
    // Found like a rename: `$TEAMRIG_SESSION` first, so a session is shown its lines before its first `inbox read`.
    const session = await teamSessionOf(runtime, kit, own.roster, claudeSession);
    if (session !== undefined) {
        await logPrompt(runtime, { config, paths: kit.paths, id: session }, payload).catch(() => undefined);
    }
    const cancelled = session === undefined ? undefined : await cancelledRestartLine(runtime, kit, session, reaskGrowth(config.refresh)).catch(() => undefined);
    const lines = session === undefined ? undefined : await inboxLinesFor(runtime, kit, session, claudeSession, teamZone(config, runtime));
    const budgetLine = session === undefined ? undefined : await promptBudgetLine(runtime, { kit, config, roster: own.roster, id: session }).catch(() => undefined);
    // An unreadable title may be one the user set, so only a title read as absent is given.
    const tabTitle = title.kind === 'read' ? tabTitleFor(own.roster, session, title.title) : undefined;
    const texts = [bound, renamed, hint, cancelled, lines, budgetLine].filter((text) => text !== undefined);
    for (const text of promptOutput(texts, tabTitle)) {
        runtime.out.stdout(text);
    }
    return EXIT.ok;
}
/**
 * PreToolUse on SendMessage: while the owner's daily meeting is open, holds every message to the lead but a
 * CRITICAL one (hook-meeting.ts); otherwise holds once a message to a team session idle
 * `messages.coldAfterMinutes` or longer, which would wake it cold, and the same tab's next send to it goes
 * through. Outside a loaded team it prints nothing.
 */
export async function coldSend(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const claudeSession = sessionIdOf(payload);
    if (claudeSession === null || sendTargetOf(payload) === undefined) {
        return EXIT.ok;
    }
    const found = await sessionTeam(payload, runtime);
    if (found.kind !== 'team') {
        return EXIT.ok;
    }
    const kit = await openKit(runtime, found.team);
    if (kit.load.status !== 'loaded') {
        return EXIT.ok;
    }
    const { config } = kit.load;
    const roster = await rosterOf(runtime, kit, config);
    const hold = (await meetingHold(runtime, kit, config, roster, payload, claudeSession)) ?? (await coldSendHold(runtime, kit, config, roster, payload, claudeSession));
    if (hold !== undefined) {
        runtime.out.stdout(hold);
    }
    return EXIT.ok;
}
/**
 * PostToolUse on SendMessage: after a send that was not delivered (no live session answers to the name),
 * hands the model one line to leave the message as an inbox line instead, so it is not lost. Outside a
 * loaded team it prints nothing.
 */
export async function failedSend(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const failed = failedSendOf(payload);
    if (failed === undefined) {
        return EXIT.ok;
    }
    const found = await sessionTeam(payload, runtime);
    if (found.kind !== 'team') {
        return EXIT.ok;
    }
    const kit = await openKit(runtime, found.team);
    if (kit.load.status !== 'loaded') {
        return EXIT.ok;
    }
    const receiver = (await rosterOf(runtime, kit, kit.load.config)).lookup(failed.to);
    runtime.out.stdout(failedSendOutput(failedSendLine(failed, receiver.ok ? receiver.id : undefined, KIT_NAME)));
    return EXIT.ok;
}
/**
 * PreToolUse on Agent (and the older Task): asks the person before a helper launch, or refuses it, when
 * the session is past its daily budget while the team is ahead of its pace line, or in the team's quiet
 * hours, as `budget.overAction` and `budget.quietHours` say. The lead and a lifted session always go
 * ahead. Outside a loaded team, with the budget off or on any error it prints nothing.
 */
export async function helperGateHook(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    if (!isRecord(payload)) {
        return EXIT.ok;
    }
    const output = await helperGateOf(runtime, payload).catch(() => undefined);
    if (output !== undefined) {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
async function helperGateOf(runtime, payload) {
    const scope = await hookScopeOf(runtime, payload);
    return scope === undefined ? undefined : helperGateOutput(runtime, scope, stringField(payload, 'transcript_path'));
}
/**
 * A loaded team's rules.md and rename log, after binding a hand-started tab by its Claude Code title
 * and recording a Claude Code rename of the session; the pointer to its handover after a refresh; who
 * the session is: `$TEAMRIG_SESSION`, else the area it read its inbox as or was bound to, so a tab that
 * set the team up keeps its identity across a compact or resume; after a refresh or a compaction its live
 * tasks; whether it runs on its configured model and effort; its verifying tasks; and where the team sits
 * in a tree of teams, read from every team config of the kit home. It also marks a /clear or a compaction in the
 * session's turn log and prunes the log's old hours (hook-turn-log.ts).
 */
async function teamPartsOf(runtime, kit, config, payload) {
    const title = await readTitle(runtime, payload);
    const claudeSession = sessionIdOf(payload);
    const bound = claudeSession === null ? undefined : await startBindNoteOf(runtime, kit, config, payload, claudeSession, title);
    const renamed = sessionStartNote(await titleOutcome(runtime, kit, config, payload, title));
    const titleNote = bound === undefined || renamed === undefined ? (bound ?? renamed) : `${bound} ${renamed}`;
    const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
    const roster = new Roster(config, kit.paths.team, renames);
    const refresh = await refreshStartOf(runtime, kit, config, roster, payload);
    const text = await runtime.files.read(kit.paths.teamRules);
    const fromEnv = envSession(runtime);
    const { tree } = await loadTree(runtime);
    const session = fromEnv ?? (await startSessionOf(runtime, kit, roster, payload));
    const id = rosterIdOf(roster, session);
    if (id !== undefined) {
        await logStart(runtime, { config, paths: kit.paths, id }, payload).catch(() => undefined);
    }
    return {
        teamRules: text === undefined ? undefined : { path: kit.paths.teamRules, text },
        renames,
        titleNote,
        refreshNote: refresh.note,
        liveTasksNote: await liveTasksPartOf(runtime, kit, config, id, payload, refresh),
        modelNote: modelNoteOf(config, roster, id, payload),
        verifyNote: await verifyNoteOf(runtime, kit.paths, id),
        session,
        sessionInEnv: fromEnv !== undefined,
        tree: tree.placeOf(kit.paths.team),
    };
}
/**
 * The SessionStart note for a tab bound as it started: by its title, else, after a /clear, by the Claude
 * Code process its session refreshed in (a /clear keeps the process; the title may name no session).
 */
async function startBindNoteOf(runtime, kit, config, payload, claudeSession, title) {
    const roster = await rosterOf(runtime, kit, config);
    const { outcome } = await bindTab(runtime, kit, { team: kit.paths.team, roster }, claudeSession, title);
    const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
    if (source !== 'clear' || outcome.kind === 'kept' || outcome.kind === 'bound') {
        return boundStartNote(outcome);
    }
    return bindAfterClear(runtime, kit, roster, claudeSession);
}
/**
 * The line for a session of the team that runs on another model than its `launch` entry (for the
 * lead, unset: `opus`), from the payload's model; Claude Code leaves it out at some starts, and then
 * nothing is checked. The effort is checked at the first Stop: SessionStart gets no effort level, and
 * `$CLAUDE_EFFORT` here can be the value of the session whose shell started this one.
 */
function modelNoteOf(config, roster, id, payload) {
    if (id === undefined) {
        return undefined;
    }
    const running = { model: isRecord(payload) ? stringField(payload, 'model') : undefined, effort: undefined };
    return modelCheckLine(roster.nameOf(id) ?? id, launchOf(config, id), running);
}
/** The team session an id or any name it has had finds; undefined for none, or a name the team does not know. */
function rosterIdOf(roster, session) {
    const found = session === undefined ? undefined : roster.lookup(session);
    return found?.ok === true ? found.id : undefined;
}
/**
 * What the session that wrote the handover leaves for this fresh one: its scheduled jobs (kept by a /clear,
 * lost with a new process) and wake-up, and its scratchpad and plan file. A transcript it cannot read is
 * said, never thrown: the note itself must still reach the session.
 */
async function carriedLinesOf(runtime, transcript, source, zone) {
    const now = runtime.clock.now();
    try {
        const places = { tempDir: claudeTempDir(runtime.env, tmpdir()), claudeDir: claudeConfigDir(runtime.env, runtime.userHome) };
        const carry = await readCarry(runtime.files, transcript, now, places);
        return carry === undefined ? [] : carryLines(carry, now, carryStartOf(source), zone);
    }
    catch (error) {
        return [`${KIT_NAME} could not read what your old session left in ${transcript} (${errorMessage(error)}); check CronList against your handover.`];
    }
}
const NO_REFRESH = { note: undefined, refreshed: false };
/**
 * A fresh start (`/clear`, a new process) after the session's handover was marked ready: the note
 * that points it at the handover, given once. A start that keeps the old context (compact, resume)
 * leaves the handover waiting; a small context again (a compaction too) starts the task count over.
 * It never throws, so the session always gets its rules.
 */
async function refreshStartOf(runtime, kit, config, roster, payload) {
    try {
        const id = await teamSessionOf(runtime, kit, roster, sessionIdOf(payload));
        if (id === undefined) {
            return NO_REFRESH;
        }
        const store = new RefreshStore(runtime.files, kit.paths);
        const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
        const now = new Date(runtime.clock.now()).toISOString();
        const state = await store.state(id);
        const decision = decideStart(state, source, config.refresh, store.handoverPath(id), now);
        if (decision.kind === 'none') {
            return NO_REFRESH;
        }
        await store.setState(id, decision.state);
        if (decision.kind === 'reset') {
            return NO_REFRESH;
        }
        await store.clearRequest(id);
        const carried = state?.phase === 'ready' && state.transcript !== null ? await carriedLinesOf(runtime, state.transcript, source, teamZone(config, runtime)) : [];
        return { note: [decision.note, ...carried].join('\n'), refreshed: true };
    }
    catch (error) {
        return { note: `${KIT_NAME} could not check for a refresh handover (${errorMessage(error)}); if you wrote one before a /clear, read it first.`, refreshed: false };
    }
}
/** The live-task block (hooks/live-tasks.ts) at the fresh start after a refresh and after a compaction; none at another start or for no session. */
async function liveTasksPartOf(runtime, kit, config, id, payload, refresh) {
    const source = isRecord(payload) ? stringField(payload, 'source') : undefined;
    return id !== undefined && showsLiveTasks(source, refresh.refreshed) ? liveTasksNoteOf(runtime, kit.paths, id, teamZone(config, runtime)) : undefined;
}
/** The refresh facts every turn end may need: the lead's request and the context size from the transcript's tail. */
async function stopFactsOf(runtime, roster, store, id, payload) {
    const request = await store.request(id);
    const transcript = stringField(payload, 'transcript_path');
    return {
        requestedBy: request === undefined ? undefined : (roster.nameOf(request.by) ?? request.by),
        tokens: transcript === undefined ? undefined : await readContextTokens(runtime.files, transcript),
        due: undefined,
    };
}
/** The facts a due refresh or notice reads (`dueFactsAt`), the running work from the transcript Claude Code gave the hook. */
function dueFactsOf(runtime, store, id, payload) {
    return dueFactsAt(runtime, store, id, stringField(payload, 'transcript_path'));
}
/** The owner's turn-end line when the lead did hand-off work itself (lead-boundary.ts); none for another session, with the boundary off or without a transcript. */
async function leadStopLines(runtime, scope, transcript) {
    const { kit, config, id } = scope;
    if (!config.leadBoundary.enabled || id !== config.roles.lead || transcript === undefined) {
        return [];
    }
    const text = await runtime.files.readTail(transcript, TRANSCRIPT_TAIL_BYTES);
    if (text === undefined) {
        return [];
    }
    const turn = turnToolsOf(text, Buffer.byteLength(text, 'utf8') >= TRANSCRIPT_TAIL_BYTES, undefined);
    const line = leadStopLine(leadTallyOf(turn, leadOwnPaths(runtime, kit, config)), config.leadBoundary.searchNudgeAt);
    return line === undefined ? [] : [line];
}
/** The refresh decision for this turn's end; none with refresh off. */
async function refreshDecisionOf(runtime, scope, payload) {
    const { kit, config, roster, id } = scope;
    if (!config.refresh.enabled) {
        return { kind: 'none' };
    }
    const store = new RefreshStore(runtime.files, kit.paths);
    const state = await store.state(id);
    const target = restartTargetOf(runtime, payload);
    const context = {
        stopHookActive: payload['stop_hook_active'] === true,
        settings: config.refresh,
        now: new Date(runtime.clock.now()).toISOString(),
        session: { id, name: roster.nameOf(id) ?? id },
        handoverPath: store.handoverPath(id),
        command: KIT_NAME,
        canRestart: config.refresh.autoRestart && target !== undefined,
        transcript: stringField(payload, 'transcript_path') ?? null,
    };
    // The facts are read only as far as the decision needs them: most turn ends stop at the transcript's tail.
    const first = decideStop(state, context);
    const facts = first.kind === 'measure' ? await stopFactsOf(runtime, roster, store, id, payload) : undefined;
    const measured = facts === undefined ? first : decideStop(state, context, facts);
    const decided = facts !== undefined && measured.kind === 'measure' ? decideStop(state, context, { ...facts, due: await dueFactsOf(runtime, store, id, payload) }) : measured;
    const decision = decided.kind === 'notice' && decided.restart && target !== undefined ? await armRestart(runtime, store, { team: kit.paths.team, id, context, target }, decided) : decided;
    switch (decision.kind) {
        case 'write':
        case 'block':
            // Written before anything is printed: a block whose state is not recorded would ask again at every stop.
            await store.setState(id, decision.state);
            break;
        case 'notice':
            // With the Claude Code process it is given in: a /clear keeps the process, so the fresh tab binds by it.
            await store.setState(id, { ...decision.state, claudePid: (await claudeProcessOf(runtime.sessionProcesses, runtime.sessionProcesses.parentPid)) ?? null });
            break;
        case 'none':
        case 'measure':
            break;
    }
    return decision;
}
/** The model notices for the user at this turn's end (`stopModelNotices`); none without a Claude Code session id. */
async function modelNoticesOf(runtime, scope, payload) {
    const claude = sessionIdOf(payload);
    if (claude === null) {
        return [];
    }
    const { kit, config, roster, id } = scope;
    return stopModelNotices(runtime.files, new ModelNoticeStore(runtime.files, kit.paths.modelNotices), {
        id,
        name: roster.nameOf(id) ?? id,
        launch: launchOf(config, id),
        claude,
        effort: payloadEffortOf(payload),
        transcript: stringField(payload, 'transcript_path'),
    });
}
/**
 * The one-time ask that sends the session back at this turn's end: for a hired session, to retire itself
 * (retire-ask.ts), else, while a task of it waits, to work its other tasks (keep-working.ts). None on a stop the
 * hook already blocked, or while the refresh blocks or waits for its restart, so the asks wait for a later stop.
 */
async function askBlockOf(runtime, scope, payload, decision) {
    if (payload['stop_hook_active'] === true || decision.kind === 'block' || decision.kind === 'notice') {
        return undefined;
    }
    return (await retireAskReasonOf(runtime, scope.config, scope.kit.paths, scope.id)) ?? keepWorkingReasonOf(runtime, scope);
}
/**
 * The tab's title at this turn's end with tab status on (hook-tab-status.ts): a circle before the refresh
 * notice's title, else before the session's topic. Undefined with tab status off, which leaves the notice's
 * own title, at a block, whose turn goes on, and on an error.
 */
async function stopTabTitleOf(runtime, config, payload, decision) {
    if (!tabStatusOn(runtime.env, config) || decision.kind === 'block') {
        return undefined;
    }
    return tabTitleOf(runtime, payload, decision.kind === 'notice' ? decision.title : undefined).catch(() => undefined);
}
/**
 * What the Stop hook prints for this turn's end; '' outside a team, and only the tab's title (with tab status
 * on) in a tab that is no session of it. The refresh, the model notices, the budget lines and the verify-by
 * lines fail apart: an error in one leaves the others.
 */
async function stopOutputOf(runtime, payload) {
    const team = await teamScopeOf(runtime, payload);
    const scope = team === undefined ? undefined : await sessionScopeOf(runtime, team, payload);
    if (scope === undefined) {
        const none = { kind: 'none' };
        return team === undefined ? '' : stopOutput(none, [], await stopTabTitleOf(runtime, team.config, payload, none));
    }
    await logReply(runtime, { config: scope.config, paths: scope.kit.paths, id: scope.id }, payload).catch(() => undefined);
    // Before the refresh, which records a block's state before it prints: this block leaves the rest to the next stop.
    const dropped = await droppedEditReasonOf(runtime, payload, 'main').catch(() => undefined);
    if (dropped !== undefined) {
        return blockOutput(dropped);
    }
    const decision = await refreshDecisionOf(runtime, scope, payload).catch(() => ({ kind: 'none' }));
    const notices = await modelNoticesOf(runtime, scope, payload).catch(() => []);
    const budget = await stopBudgetLines(runtime, scope, stringField(payload, 'transcript_path')).catch(() => []);
    const verify = await verifyByLinesOf(runtime, scope.kit.paths, scope.id, teamZone(scope.config, runtime)).catch(() => []);
    await startAutoSync(runtime, scope.kit, scope.config).catch(() => undefined);
    const lead = await leadStopLines(runtime, scope, stringField(payload, 'transcript_path')).catch(() => []);
    const lines = [...notices, ...budget, ...verify, ...lead];
    const ask = await askBlockOf(runtime, scope, payload, decision).catch(() => undefined);
    return ask === undefined ? stopOutput(decision, lines, await stopTabTitleOf(runtime, scope.config, payload, decision)) : blockOutput(ask, lines);
}
/**
 * Stop, at the end of every turn: first sends the session back, once, to a skill edit of the turn that
 * Claude Code refused and it never redid (hook-dropped-edit.ts), leaving the rest to its next stop. It asks the session for its handover once when its context reached the
 * team's threshold or the lead asked, and at a task end (`set done`) also after enough tasks, then tells the user
 * once that it waits for /clear, or with `refresh.autoRestart` that it restarts by itself when idle (hook-restart.ts). It also tells the user, once each, when the session runs at another
 * effort than its `launch` entry or Claude Code switched its model after a safeguard stop, and once a
 * day when the date to verify one of its verifying tasks by has come. Under `hiring.policy` `automatic` it asks a
 * hired session whose last open task closed, once, to write its handover and retire; after a `set` to waiting it sends the
 * session, once, to its work it can start that does not come after the waiting task (keep-working.ts),
 * never in quiet hours or past its daily budget. Once per `github.everyMinutes` for the whole
 * team it starts `gh sync --auto` hidden in the background (gh-auto.ts). With tab status on, it also sets the
 * tab's title to the ready circle, or the working one while a helper runs, in any tab of the team (hook-tab-status.ts).
 * Each team session's reply is logged for the task pane (hook-turn-log.ts).
 * A turn with nothing to say reads only small files and the transcript's tail (and, at the first stop of a UTC day,
 * the register log; with tab status on, the longer tail where helpers start), and prints nothing but the tab's title.
 * It never blocks on an error, and ignores input that is not a hook payload (which would judge a boundary without
 * its transcript): a refresh is a convenience, and the next stop tries again.
 */
export async function stop(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const output = isRecord(payload) ? await stopOutputOf(runtime, payload).catch(() => '') : '';
    if (output !== '') {
        runtime.out.stdout(output);
    }
    return EXIT.ok;
}
/**
 * SessionStart: the core rules from the team config, who the session is (after a refresh, its handover; after a
 * refresh or a compaction, its live tasks), and the team's rules.md. A compaction inside a helper fires it too,
 * under the session's id: that start gets the helper's context (hook-helper-start.ts) and binds, renames and
 * refreshes nothing.
 */
export async function sessionStart(args, runtime) {
    noPositionals(args);
    const payload = parseJson(await runtime.readStdin());
    const found = await sessionTeam(payload, runtime);
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
    const helper = helperOf(payload);
    if (helper !== undefined) {
        // A compaction inside a helper: the helper's rules again, and none of the session's side effects.
        runtime.out.stdout(sessionStartOutput(await helperContextOf(runtime, kit, payload, helper.agentType)));
        return EXIT.ok;
    }
    const parts = kit.load.status === 'loaded'
        ? await teamPartsOf(runtime, kit, kit.load.config, payload)
        : {
            teamRules: undefined,
            renames: [],
            titleNote: undefined,
            refreshNote: undefined,
            liveTasksNote: undefined,
            modelNote: undefined,
            verifyNote: undefined,
            session: undefined,
            sessionInEnv: false,
            tree: undefined,
        };
    const context = sessionStartContext({ team: found.team, load: kit.load, ...parts, command: KIT_NAME, platform: runtime.platform, clock: rulesClockOf(runtime) });
    const requirementsNote = await requirementsNoteOnce({
        problems: await runtime.requirements.problems(),
        log: new JsonlHintLog(runtime.files, kit.paths.bindHints),
        claudeSession: sessionIdOf(payload),
        now: new Date(runtime.clock.now()),
        command: KIT_NAME,
    });
    runtime.out.stdout(sessionStartOutput(context, [parts.modelNote, requirementsNote]));
    return EXIT.ok;
}
