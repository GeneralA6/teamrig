import type { EffortLevel } from '../config/types.ts';
import { errorMessage } from '../core/guards.ts';
import type { Clock, Sleep } from '../core/lock.ts';
import type { PathProbe } from '../core/path-probe.ts';
import { samePath } from '../core/paths.ts';
import { customTitleOf } from '../names/title.ts';
import { CARRY_TAIL_BYTES } from '../refresh/carry.ts';
import { resumeFolderOf } from '../sessions/resume-folder.ts';
import type { Countdown } from './countdown.ts';
import type { RestoreEntry } from './entry.ts';
import {
  chooseMode,
  CLOSED_KEEP_MS,
  continuePrompt,
  diedAt,
  judgeEntry,
  lastRecordedEffort,
  lostWorkOf,
  nearestExistingFolder,
  selectRestorePlan,
  summarizeRestore,
  type JudgeFacts,
  type Judged,
  type Judgement,
  type LostWork,
  type RestoreMode,
  type RestorePlan,
} from './plan.ts';
import type { RestoreRegistry } from './registry.ts';
import type { ShutdownLog } from './shutdowns.ts';
import type { StopWatch } from './stops.ts';
import { teamSessionOf, type RestoreTeam, type TeamSession } from './teams.ts';
import { KIND_TAIL_BYTES, transcriptKindOf, type TranscriptKind } from './transcript-kind.ts';

/** How long the person has to start, idle or cancel the restore before it starts on its own. */
export const COUNTDOWN_SECONDS = 60;
/** The pause after each reopened tab, so the terminal and Claude Code start it before the next. */
export const TAB_STAGGER_MS = 4_000;

/** A tab to reopen for a restored session. */
export interface ReopenTab {
  readonly claudeSession: string;
  readonly title: string;
  /** The folder `claude --resume` finds its transcript from, else its own folder or the nearest existing parent of it. */
  readonly folder: string;
  readonly team: TeamSession | undefined;
  readonly effort: EffortLevel | undefined;
  /** The first prompt; undefined reopens it idle. */
  readonly prompt: string | undefined;
}

export type ReopenOutcome = { readonly kind: 'opened' } | { readonly kind: 'failed'; readonly why: string };

/** What the restore reads and changes outside itself. */
export interface RestoreDeps {
  readonly registry: RestoreRegistry;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly probe: PathProbe;
  readonly shutdowns: ShutdownLog;
  readonly countdown: Countdown;
  readonly stops: StopWatch;
  readonly teams: readonly RestoreTeam[];
  /** Where a session whose folder and every parent of it are gone reopens: the person's home folder. */
  readonly home: string;
  /** Claude Code's folder of project transcripts, whose subfolder holding a transcript names the folder it resumes from. */
  readonly projectsDir: string;
  readonly platform: NodeJS.Platform;
  /** Whether the session's recorded process still runs Claude Code. */
  stillRunning(entry: RestoreEntry): Promise<boolean>;
  /** Where the session's transcript is now; undefined when none is left. */
  transcriptOf(entry: RestoreEntry): Promise<string | undefined>;
  readTail(path: string, maxBytes: number): Promise<string | undefined>;
  reopen(tab: ReopenTab): Promise<ReopenOutcome>;
  print(line: string): void;
  log(line: string): Promise<void>;
}

/** A session the restore reopens: why, as which team session or title, and how it comes back. */
export interface RestoreItem extends Judged {
  readonly transcript: string | undefined;
  /** The folder `claude --resume` finds its transcript from (`resumeFolderOf`); undefined when no folder it ran in does. */
  readonly resumeFolder: string | undefined;
  readonly label: string;
  readonly team: TeamSession | undefined;
  readonly lost: LostWork;
  readonly effort: EffortLevel | undefined;
  readonly mode: RestoreMode;
  readonly why: string;
}

/** What the machine says of each recorded session: still running, where its transcript is and what it says. */
async function factsOf(deps: RestoreDeps, entries: readonly RestoreEntry[], since: number): Promise<JudgeFacts> {
  const running = new Set<string>();
  const transcripts = new Map<string, string>();
  const kinds = new Map<string, TranscriptKind>();
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
async function itemOf(deps: RestoreDeps, facts: JudgeFacts, judged: Judged): Promise<RestoreItem> {
  const { entry } = judged;
  const transcript = facts.transcripts.get(entry.claudeSession);
  const text = (transcript === undefined ? undefined : await deps.readTail(transcript, CARRY_TAIL_BYTES)) ?? '';
  const lost = lostWorkOf(text, Buffer.byteLength(text, 'utf8') >= CARRY_TAIL_BYTES, diedAt(entry, facts.shutdown?.start));
  const team = teamSessionOf(entry, deps.teams);
  const label = team?.name ?? customTitleOf(text) ?? `Claude ${entry.claudeSession.slice(0, 8)}`;
  const resumeFolder = transcript === undefined ? undefined : resumeFolderOf(transcript, text, entry.projectDir, deps.projectsDir, deps.platform);
  return { ...judged, transcript, resumeFolder, label, team, lost, effort: lastRecordedEffort(text), ...chooseMode(entry, lost, team?.isLead === true) };
}

/** Where a restored session reopens, and why there when that is not the folder it started in. */
interface ReopenFolder {
  readonly folder: string;
  readonly note: string | undefined;
}

/**
 * The folder a restored session reopens in: the one `claude --resume` finds its transcript from, since Claude Code
 * files a session that went into a worktree under that worktree's project folder and resumes it from there alone
 * (T1426); else the folder it started in, or the nearest existing parent of it when that is gone, or the home folder.
 */
async function reopenFolderOf(deps: RestoreDeps, item: RestoreItem): Promise<ReopenFolder> {
  const { resumeFolder, entry } = item;
  if (resumeFolder !== undefined && (await deps.probe.kind(resumeFolder)) === 'folder') {
    const moved = !samePath(resumeFolder, entry.projectDir, deps.platform);
    return { folder: resumeFolder, note: moved ? `resumed in ${resumeFolder}, the folder its transcript is filed under` : undefined };
  }
  const folder = (await nearestExistingFolder(entry.projectDir, deps.probe)) ?? deps.home;
  return { folder, note: folder === entry.projectDir ? undefined : `${entry.projectDir} is gone; opened in ${folder}` };
}

async function itemsOf(deps: RestoreDeps, facts: JudgeFacts, restore: readonly Judged[]): Promise<RestoreItem[]> {
  const items: RestoreItem[] = [];
  for (const judged of restore) {
    items.push(await itemOf(deps, facts, judged));
  }
  return items;
}

function modeWords(item: Pick<RestoreItem, 'mode' | 'why'>): string {
  return item.mode === 'continue' ? `continue: ${item.why}` : 'idle';
}

/** How the other sessions of a lead's team come back, for the lead's first prompt. */
function leadSummaryOf(lead: RestoreItem, items: readonly RestoreItem[]): string {
  const others = items.filter((item) => item !== lead && item.team?.team === lead.team?.team);
  return summarizeRestore(others.map(({ label, mode, why }) => ({ label, mode, why })));
}

async function prune(deps: RestoreDeps, discard: readonly Judged[]): Promise<void> {
  for (const { entry, reason } of discard) {
    await deps.registry.remove(entry.claudeSession);
    await deps.log(`discarded ${entry.claudeSession} (${reason})`);
  }
}

interface Planned {
  readonly entries: readonly RestoreEntry[];
  readonly facts: JudgeFacts;
  readonly plan: RestorePlan;
}

async function planOf(deps: RestoreDeps, since: number): Promise<Planned> {
  const entries = await deps.registry.list();
  const facts = await factsOf(deps, entries, since);
  return { entries, facts, plan: selectRestorePlan(entries, facts) };
}

function printJudged(deps: RestoreDeps, verdict: string, list: readonly Judged[]): void {
  for (const { entry, reason } of list) {
    deps.print(`${verdict.padEnd(8)} ${entry.claudeSession}  ${reason}  ${entry.projectDir}`);
  }
}

function printItems(deps: RestoreDeps, verdict: string, items: readonly RestoreItem[]): void {
  for (const item of items) {
    deps.print(`${verdict.padEnd(8)} ${item.entry.claudeSession}  ${item.label}  ${item.reason}; ${modeWords(item)}; effort ${item.effort ?? 'default'}  ${item.entry.projectDir}`);
  }
}

/** `restore`: what a restore now would do with each recorded session, changing nothing. */
export async function previewRestore(deps: RestoreDeps): Promise<void> {
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
export async function checkRestore(deps: RestoreDeps): Promise<{ readonly since: number; readonly count: number }> {
  const since = deps.clock.now();
  const { plan } = await planOf(deps, since);
  await prune(deps, plan.discard);
  await deps.log(`check: ${plan.restore.length} to restore, ${plan.keep.length} kept, ${plan.closed.length} closed`);
  return { since, count: plan.restore.length };
}

export interface RestoreRun {
  readonly opened: number;
  readonly failed: number;
}

/** How far a run got: whether its countdown ended, how many it is to reopen, and what became of each so far. */
interface Progress {
  started: boolean;
  total: number;
  opened: number;
  skipped: number;
  failed: number;
}

function progressWords({ opened, skipped, failed, total }: Progress): string {
  return `${opened} opened, ${skipped} skipped, ${failed} failed of ${total}`;
}

function printGroup(deps: RestoreDeps, heading: string, items: readonly RestoreItem[]): void {
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
export async function runRestore(deps: RestoreDeps, since: number): Promise<RestoreRun> {
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
  } else {
    printGroup(deps, `Claude Code sessions closed outside a shutdown in the last ${KEEP_HOURS} h (${closed.length}):`, closed);
  }
  if (extra.length > 0) {
    printGroup(deps, `Closed outside a shutdown in the last ${KEEP_HOURS} h (${extra.length}), reopened only with [a]:`, extra);
  }
  deps.print(
    'Sessions marked "continue" resume with a message to re-check the state and carry on (mid-turn, an API error, ' +
      'work live at the shutdown, or the lead); the others reopen idle, with no prompt.',
  );
  const progress: Progress = { started: false, total: first.length, opened: 0, skipped: 0, failed: 0 };
  const unwatch = deps.stops.watch((signal) =>
    deps.log(`run: interrupted by ${signal} ${progress.started ? `after ${progressWords(progress)}` : 'at the countdown'}`),
  );
  try {
    await reopenAll(deps, facts, { first, extra }, progress);
  } finally {
    unwatch();
  }
  return { opened: progress.opened, failed: progress.failed };
}

/** The sessions a run reopens on its own (`first`), and the closed tabs it adds only on `a` (`extra`). */
interface RunGroups {
  readonly first: readonly RestoreItem[];
  readonly extra: readonly RestoreItem[];
}

async function reopenAll(deps: RestoreDeps, facts: JudgeFacts, { first, extra }: RunGroups, progress: Progress): Promise<void> {
  const choice = await deps.countdown.choose(COUNTDOWN_SECONDS, extra.length);
  if (choice === 'cancel') {
    deps.print('Cancelled: nothing was reopened. Run "teamrig restore run" to try again.');
    await deps.log('run: cancelled');
    return;
  }
  const taken = choice === 'all' ? [...first, ...extra] : first;
  const chosen = choice === 'idle' ? taken.map((item): RestoreItem => ({ ...item, mode: 'idle', why: 'reopened idle' })) : taken;
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

async function reopenItem(deps: RestoreDeps, facts: JudgeFacts, item: RestoreItem, items: readonly RestoreItem[]): Promise<'opened' | 'skipped' | 'failed'> {
  const id = item.entry.claudeSession;
  const current = await deps.registry.read(id);
  const recheck: Judgement = current === undefined ? { verdict: 'discard', reason: 'its entry is gone' } : judgeEntry(current, { ...facts, now: deps.clock.now() });
  // A closed tab the person chose to reopen still judges `closed`; any other verdict means it needs no reopen now.
  if (current === undefined || (recheck.verdict !== 'restore' && recheck.verdict !== 'closed')) {
    deps.print(`Skipped ${item.label} (${recheck.reason})`);
    await deps.log(`run: skipped ${id} (${recheck.reason})`);
    return 'skipped';
  }
  const { folder, note } = await reopenFolderOf(deps, item);
  const prompt = item.mode === 'idle' ? undefined : continuePrompt(item.lost, item.team?.isLead === true ? leadSummaryOf(item, items) : undefined);
  await deps.registry.write({ ...current, transcriptPath: item.transcript ?? current.transcriptPath, restoreAttempts: current.restoreAttempts + 1, restoredAt: deps.clock.now() });
  let outcome: ReopenOutcome;
  try {
    outcome = await deps.reopen({ claudeSession: id, title: item.label, folder, team: item.team, effort: item.effort, prompt });
  } catch (error) {
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
  await deps.log(`run: opened ${id} (${modeWords(item)}) at effort ${item.effort ?? 'default'}`);
  return 'opened';
}
