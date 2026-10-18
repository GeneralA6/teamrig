import { errorMessage } from "../core/guards.js";
import { customTitleOf } from "../names/title.js";
import { CARRY_TAIL_BYTES } from "../refresh/carry.js";
import { chooseMode, continuePrompt, diedAt, judgeEntry, lastRecordedEffort, lostWorkOf, nearestExistingFolder, selectRestorePlan, summarizeRestore, } from "./plan.js";
import { teamSessionOf } from "./teams.js";
/** How long the person has to start, idle or cancel the restore before it starts on its own. */
export const COUNTDOWN_SECONDS = 60;
/** The pause after each reopened tab, so the terminal and Claude Code start it before the next. */
export const TAB_STAGGER_MS = 4_000;
/** What the machine says of each recorded session: still running, and where its transcript is. */
async function factsOf(deps, entries, since) {
    const running = new Set();
    const transcripts = new Map();
    // One at a time: on Windows each process check starts a program.
    for (const entry of entries) {
        if (await deps.stillRunning(entry)) {
            running.add(entry.claudeSession);
        }
        const transcript = await deps.transcriptOf(entry);
        if (transcript !== undefined) {
            transcripts.set(entry.claudeSession, transcript);
        }
    }
    return { now: deps.clock.now(), since, shutdownStart: await deps.shutdowns.lastShutdownStart(), running, transcripts };
}
/** The label is the team session's name, else the title the person gave the session, else its short id. */
async function itemOf(deps, facts, judged) {
    const { entry } = judged;
    const transcript = facts.transcripts.get(entry.claudeSession);
    const text = (transcript === undefined ? undefined : await deps.readTail(transcript, CARRY_TAIL_BYTES)) ?? '';
    const lost = lostWorkOf(text, Buffer.byteLength(text, 'utf8') >= CARRY_TAIL_BYTES, diedAt(entry, facts.shutdownStart));
    const team = teamSessionOf(entry, deps.teams);
    const label = team?.name ?? customTitleOf(text) ?? `Claude ${entry.claudeSession.slice(0, 8)}`;
    return { ...judged, transcript, label, team, lost, effort: lastRecordedEffort(text), ...chooseMode(entry, lost, team?.isLead === true) };
}
async function itemsOf(deps, facts, restore) {
    const items = [];
    for (const judged of restore) {
        items.push(await itemOf(deps, facts, judged));
    }
    return items;
}
function modeWords(item) {
    return item.mode === 'continue' ? `continue: ${item.why}` : 'idle';
}
/** How the other sessions of a lead's team come back, for the lead's first prompt. */
function leadSummaryOf(lead, items) {
    const others = items.filter((item) => item !== lead && item.team?.team === lead.team?.team);
    return summarizeRestore(others.map(({ label, mode, why }) => ({ label, mode, why })));
}
async function prune(deps, discard) {
    for (const { entry, reason } of discard) {
        await deps.registry.remove(entry.claudeSession);
        await deps.log(`discarded ${entry.claudeSession} (${reason})`);
    }
}
async function planOf(deps, since) {
    const entries = await deps.registry.list();
    const facts = await factsOf(deps, entries, since);
    return { entries, facts, plan: selectRestorePlan(entries, facts) };
}
function printJudged(deps, verdict, list) {
    for (const { entry, reason } of list) {
        deps.print(`${verdict.padEnd(8)} ${entry.claudeSession}  ${reason}  ${entry.projectDir}`);
    }
}
/** `restore`: what a restore now would do with each recorded session, changing nothing. */
export async function previewRestore(deps) {
    const { entries, facts, plan } = await planOf(deps, deps.clock.now());
    if (entries.length === 0) {
        deps.print('No Claude Code session is recorded.');
        return;
    }
    const items = await itemsOf(deps, facts, plan.restore);
    for (const item of items) {
        deps.print(`RESTORE  ${item.entry.claudeSession}  ${item.label}  ${item.reason}; ${modeWords(item)}; effort ${item.effort ?? 'default'}  ${item.entry.projectDir}`);
    }
    printJudged(deps, 'KEEP', plan.keep);
    printJudged(deps, 'DISCARD', plan.discard);
    for (const lead of items.filter((item) => item.team?.isLead === true)) {
        const summary = leadSummaryOf(lead, items);
        deps.print(`Lead ${lead.label} hears: ${summary === '' ? 'no other session of its team' : summary}`);
    }
}
/** `restore check` at logon: drops the entries no restore needs; the count of sessions to restore and the logon time. */
export async function checkRestore(deps) {
    const since = deps.clock.now();
    const { plan } = await planOf(deps, since);
    await prune(deps, plan.discard);
    await deps.log(`check: ${plan.restore.length} to restore, ${plan.keep.length} kept`);
    return { since, count: plan.restore.length };
}
/**
 * Reopens the sessions the last shutdown killed, after a countdown the person may cut short, turn into an
 * idle reopen of all, or cancel. Each is judged again just before its tab opens, since a second run or the
 * person may have reopened it meanwhile. Its entry counts the attempt before the tab opens, so a session that
 * keeps failing to resume is dropped after MAX_RESTORE_ATTEMPTS; a tab that did not open takes the count back.
 */
export async function runRestore(deps, since) {
    const { facts, plan } = await planOf(deps, since);
    await prune(deps, plan.discard);
    if (plan.restore.length === 0) {
        deps.print('No Claude Code sessions to restore.');
        await deps.log('run: nothing to restore');
        return { opened: 0, failed: 0 };
    }
    const items = await itemsOf(deps, facts, plan.restore);
    deps.print(`Claude Code sessions the last shutdown interrupted (${items.length}):`);
    for (const item of items) {
        deps.print(`  ${item.label}   [${item.reason}; ${modeWords(item)}]   ${item.entry.projectDir}`);
    }
    deps.print('Sessions marked "continue" resume with a message to re-check the state and carry on (mid-turn, an API error, ' +
        'work live at the shutdown, or the lead); the others reopen idle, with no prompt.');
    const choice = await deps.countdown.choose(COUNTDOWN_SECONDS);
    if (choice === 'cancel') {
        deps.print('Cancelled: nothing was reopened. Run "teamrig restore run" to try again.');
        await deps.log('run: cancelled');
        return { opened: 0, failed: 0 };
    }
    const chosen = choice === 'idle' ? items.map((item) => ({ ...item, mode: 'idle', why: 'reopened idle' })) : items;
    let opened = 0;
    let failed = 0;
    for (const [index, item] of chosen.entries()) {
        const outcome = await reopenItem(deps, facts, item, chosen);
        if (outcome === 'opened') {
            opened += 1;
            if (index < chosen.length - 1) {
                await deps.sleep(TAB_STAGGER_MS);
            }
        }
        else if (outcome === 'failed') {
            failed += 1;
        }
    }
    return { opened, failed };
}
async function reopenItem(deps, facts, item, items) {
    const id = item.entry.claudeSession;
    const current = await deps.registry.read(id);
    const recheck = current === undefined ? { verdict: 'discard', reason: 'its entry is gone' } : judgeEntry(current, { ...facts, now: deps.clock.now() });
    if (current === undefined || recheck.verdict !== 'restore') {
        deps.print(`Skipped ${item.label} (${recheck.reason})`);
        await deps.log(`run: skipped ${id} (${recheck.reason})`);
        return 'skipped';
    }
    const folder = (await nearestExistingFolder(item.entry.projectDir, deps.probe)) ?? deps.home;
    const prompt = item.mode === 'idle' ? undefined : continuePrompt(item.lost, item.team?.isLead === true ? leadSummaryOf(item, items) : undefined);
    await deps.registry.write({ ...current, transcriptPath: item.transcript ?? current.transcriptPath, restoreAttempts: current.restoreAttempts + 1, restoredAt: deps.clock.now() });
    let outcome;
    try {
        outcome = await deps.reopen({ claudeSession: id, title: item.label, folder, team: item.team, effort: item.effort, prompt });
    }
    catch (error) {
        outcome = { kind: 'failed', why: errorMessage(error) };
    }
    if (outcome.kind === 'failed') {
        await deps.registry.write(current);
        deps.print(`FAILED to reopen ${item.label}: ${outcome.why}`);
        await deps.log(`run: failed ${id} (${outcome.why})`);
        return 'failed';
    }
    if (folder !== item.entry.projectDir) {
        deps.print(`  (${item.entry.projectDir} is gone; opened in ${folder})`);
    }
    deps.print(`Opened ${item.label} (${modeWords(item)})`);
    await deps.log(`run: opened ${id} (${modeWords(item)}) at effort ${item.effort ?? 'default'}`);
    return 'opened';
}
