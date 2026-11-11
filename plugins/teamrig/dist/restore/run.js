import { errorMessage } from "../core/guards.js";
import { samePath } from "../core/paths.js";
import { customTitleOf } from "../names/title.js";
import { CARRY_TAIL_BYTES } from "../refresh/carry.js";
import { resumeFolderOf } from "../sessions/resume-folder.js";
import { ARCHIVE_KEEP_MS } from "./archive.js";
import { chooseMode, CLOSED_KEEP_MS, continuePrompt, diedAt, judgeEntry, lastRecordedEffort, lostWorkOf, nearestExistingFolder, selectRestorePlan, summarizeRestore, } from "./plan.js";
import { teamSessionOf } from "./teams.js";
import { KIND_TAIL_BYTES, transcriptKindOf } from "./transcript-kind.js";
/** How long the person has to start, idle or cancel the restore before it starts on its own. */
export const COUNTDOWN_SECONDS = 60;
/** The pause after each reopened tab, so the terminal and Claude Code start it before the next. */
export const TAB_STAGGER_MS = 4_000;
/**
 * The config's `launch.<id>.effort` wins once set, so a restore after a config change brings the session back on the
 * new level, not the old one its transcript ran at (T2440); a session the config leaves unset comes back at its last.
 */
function reopenEffortOf(team, text) {
    if (team?.effort !== undefined) {
        return { level: team.effort, from: 'config' };
    }
    const last = lastRecordedEffort(text);
    return last === undefined ? undefined : { level: last, from: 'last run' };
}
/** The effort in words for the preview and the log: `high (config)`, `max (last run)` or `default`. */
function effortWords(effort) {
    return effort === undefined ? 'default' : `${effort.level} (${effort.from})`;
}
/** What the machine says of each recorded session: still running, where its transcript is and what it says. */
async function factsOf(deps, entries, since) {
    const running = new Set();
    const transcripts = new Map();
    const kinds = new Map();
    // One at a time: on Windows each process check starts a program.
    for (const entry of entries) {
        if (await deps.stillRunning(entry)) {
            running.add(entry.claudeSession);
        }
        const transcript = await deps.transcriptOf(entry);
        if (transcript !== undefined) {
            transcripts.set(entry.claudeSession, transcript);
            const tail = await deps.readTail(transcript, KIND_TAIL_BYTES);
            if (tail !== undefined) {
                kinds.set(entry.claudeSession, transcriptKindOf(tail));
            }
        }
    }
    return { now: deps.clock.now(), since, shutdown: await deps.shutdowns.lastShutdown(), running, transcripts, kinds };
}
/** The label is the team session's name, else the title the person gave the session, else its short id. */
async function itemOf(deps, facts, judged) {
    const { entry } = judged;
    const transcript = facts.transcripts.get(entry.claudeSession);
    const text = (transcript === undefined ? undefined : await deps.readTail(transcript, CARRY_TAIL_BYTES)) ?? '';
    const lost = lostWorkOf(text, Buffer.byteLength(text, 'utf8') >= CARRY_TAIL_BYTES, diedAt(entry, facts.shutdown?.start));
    const team = teamSessionOf(entry, deps.teams);
    const label = team?.name ?? customTitleOf(text) ?? `Claude ${entry.claudeSession.slice(0, 8)}`;
    const resumeFolder = transcript === undefined ? undefined : resumeFolderOf(transcript, text, entry.projectDir, deps.projectsDir, deps.platform);
    return { ...judged, transcript, resumeFolder, label, team, lost, effort: reopenEffortOf(team, text), ...chooseMode(entry, lost, team?.isLead === true) };
}
/**
 * The folder a restored session reopens in: the one `claude --resume` finds its transcript from, since Claude Code
 * files a session that went into a worktree under that worktree's project folder and resumes it from there alone
 * (T1426); else the folder it started in, or the nearest existing parent of it when that is gone, or the home folder.
 */
async function reopenFolderOf(deps, item) {
    const { resumeFolder, entry } = item;
    if (resumeFolder !== undefined && (await deps.probe.kind(resumeFolder)) === 'folder') {
        const moved = !samePath(resumeFolder, entry.projectDir, deps.platform);
        return { folder: resumeFolder, note: moved ? `resumed in ${resumeFolder}, the folder its transcript is filed under` : undefined };
    }
    const folder = (await nearestExistingFolder(entry.projectDir, deps.probe)) ?? deps.home;
    return { folder, note: folder === entry.projectDir ? undefined : `${entry.projectDir} is gone; opened in ${folder}` };
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
const ARCHIVE_KEEP_DAYS = ARCHIVE_KEEP_MS / 86_400_000;
/**
 * Moves each entry no restore needs to the archive, then deletes the archived ones past ARCHIVE_KEEP_MS. The copy is
 * written before the entry is removed, so a run stopped between the two leaves it in both, never in neither.
 */
async function prune(deps, discard) {
    const now = deps.clock.now();
    for (const { entry, reason } of discard) {
        await deps.archive.put({ entry, archivedAt: now, reason });
        await deps.registry.remove(entry.claudeSession);
        await deps.log(`archived ${entry.claudeSession} (${reason})`);
    }
    const purged = await deps.archive.purge(now);
    if (purged.length > 0) {
        await deps.log(`archive: deleted ${purged.length} archived ${ARCHIVE_KEEP_DAYS} days ago or earlier`);
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
function printItems(deps, verdict, items) {
    for (const item of items) {
        deps.print(`${verdict.padEnd(8)} ${item.entry.claudeSession}  ${item.label}  ${item.reason}; ${modeWords(item)}; effort ${effortWords(item.effort)}  ${item.entry.projectDir}`);
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
    printItems(deps, 'RESTORE', items);
    printItems(deps, 'CLOSED', await itemsOf(deps, facts, plan.closed));
    printJudged(deps, 'KEEP', plan.keep);
    printJudged(deps, 'DISCARD', plan.discard);
    for (const lead of items.filter((item) => item.team?.isLead === true)) {
        const summary = leadSummaryOf(lead, items);
        deps.print(`Lead ${lead.label} hears: ${summary === '' ? 'no other session of its team' : summary}`);
    }
}
/**
 * `restore check` at logon: drops the entries no restore needs; the count of sessions to restore and the logon time.
 * The count leaves out the tabs closed outside a shutdown: they are kept for a `restore run` the person starts, and
 * open no restore tab by themselves.
 */
export async function checkRestore(deps) {
    const since = deps.clock.now();
    const { plan } = await planOf(deps, since);
    await prune(deps, plan.discard);
    await deps.log(`check: ${plan.restore.length} to restore, ${plan.keep.length} kept, ${plan.closed.length} closed`);
    return { since, count: plan.restore.length };
}
function progressWords({ opened, skipped, failed, total }) {
    return `${opened} opened, ${skipped} skipped, ${failed} failed of ${total}`;
}
function printGroup(deps, heading, items) {
    deps.print(heading);
    for (const item of items) {
        deps.print(`  ${item.label}   [${item.reason}; ${modeWords(item)}]   ${item.entry.projectDir}`);
    }
}
const KEEP_HOURS = CLOSED_KEEP_MS / 3_600_000;
/**
 * Reopens the sessions the last shutdown killed, after a countdown the person may cut short, turn into an
 * idle reopen of all, or cancel. The tabs closed outside a shutdown are listed apart and reopen only with `a`,
 * unless no session is to restore: then they are what the person ran it for, and the countdown takes them.
 * Each is judged again just before its tab opens, since a second run or the person may have reopened it
 * meanwhile. Its entry counts the attempt before the tab opens, so a session that keeps failing to resume is
 * dropped after MAX_RESTORE_ATTEMPTS; a tab that did not open takes the count back. The log says when the
 * reopening starts and ends, and how far it got when its tab is closed meanwhile, so a run that stopped short is
 * never mistaken for one that finished (T1439).
 */
export async function runRestore(deps, since) {
    const { facts, plan } = await planOf(deps, since);
    await prune(deps, plan.discard);
    if (plan.restore.length === 0 && plan.closed.length === 0) {
        deps.print('No Claude Code sessions to restore.');
        await deps.log('run: nothing to restore');
        return { opened: 0, failed: 0 };
    }
    const restored = await itemsOf(deps, facts, plan.restore);
    const closed = await itemsOf(deps, facts, plan.closed);
    const first = restored.length > 0 ? restored : closed;
    const extra = restored.length > 0 ? closed : [];
    if (restored.length > 0) {
        printGroup(deps, `Claude Code sessions the last shutdown interrupted (${restored.length}):`, restored);
    }
    else {
        printGroup(deps, `Claude Code sessions closed outside a shutdown in the last ${KEEP_HOURS} h (${closed.length}):`, closed);
    }
    if (extra.length > 0) {
        printGroup(deps, `Closed outside a shutdown in the last ${KEEP_HOURS} h (${extra.length}), reopened only with [a]:`, extra);
    }
    deps.print('Sessions marked "continue" resume with a message to re-check the state and carry on (mid-turn, an API error, ' +
        'work live at the shutdown, or the lead); the others reopen idle, with no prompt.');
    const progress = { started: false, total: first.length, opened: 0, skipped: 0, failed: 0 };
    const unwatch = deps.stops.watch((signal) => deps.log(`run: interrupted by ${signal} ${progress.started ? `after ${progressWords(progress)}` : 'at the countdown'}`));
    try {
        await reopenAll(deps, facts, { first, extra }, progress);
    }
    finally {
        unwatch();
    }
    return { opened: progress.opened, failed: progress.failed };
}
async function reopenAll(deps, facts, { first, extra }, progress) {
    const choice = await deps.countdown.choose(COUNTDOWN_SECONDS, extra.length);
    if (choice === 'cancel') {
        deps.print('Cancelled: nothing was reopened. Run "teamrig restore run" to try again.');
        await deps.log('run: cancelled');
        return;
    }
    const taken = choice === 'all' ? [...first, ...extra] : first;
    const chosen = choice === 'idle' ? taken.map((item) => ({ ...item, mode: 'idle', why: 'reopened idle' })) : taken;
    progress.started = true;
    progress.total = chosen.length;
    const how = choice === 'idle' ? ', all idle' : choice === 'all' ? `, the ${extra.length} closed too` : '';
    await deps.log(`run: started, ${chosen.length} to reopen${how}`);
    for (const [index, item] of chosen.entries()) {
        const outcome = await reopenItem(deps, facts, item, chosen);
        progress[outcome] += 1;
        if (outcome === 'opened' && index < chosen.length - 1) {
            await deps.sleep(TAB_STAGGER_MS);
        }
    }
    await deps.log(`run: done, ${progressWords(progress)}`);
}
async function reopenItem(deps, facts, item, items) {
    const id = item.entry.claudeSession;
    const current = await deps.registry.read(id);
    const recheck = current === undefined ? { verdict: 'discard', reason: 'its entry is gone' } : judgeEntry(current, { ...facts, now: deps.clock.now() });
    // A closed tab the person chose to reopen still judges `closed`; any other verdict means it needs no reopen now.
    if (current === undefined || (recheck.verdict !== 'restore' && recheck.verdict !== 'closed')) {
        deps.print(`Skipped ${item.label} (${recheck.reason})`);
        await deps.log(`run: skipped ${id} (${recheck.reason})`);
        return 'skipped';
    }
    const { folder, note } = await reopenFolderOf(deps, item);
    const prompt = item.mode === 'idle' ? undefined : continuePrompt(item.lost, item.team?.isLead === true ? leadSummaryOf(item, items) : undefined);
    await deps.registry.write({ ...current, transcriptPath: item.transcript ?? current.transcriptPath, restoreAttempts: current.restoreAttempts + 1, restoredAt: deps.clock.now() });
    let outcome;
    try {
        outcome = await deps.reopen({ claudeSession: id, title: item.label, folder, team: item.team, effort: item.effort?.level, prompt });
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
    if (note !== undefined) {
        deps.print(`  (${note})`);
    }
    deps.print(`Opened ${item.label} (${modeWords(item)})`);
    await deps.log(`run: opened ${id} (${modeWords(item)}) at effort ${effortWords(item.effort)}; ${outcome.launch}`);
    return 'opened';
}
