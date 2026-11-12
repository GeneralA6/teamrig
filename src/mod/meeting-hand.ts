/**
 * The tab's side of a scheduled meeting's notification (T1358). Nothing runs at a meeting's time unless something
 * looks, so the plugin's mod (`hooks/register.ts`) runs a `MeetingHand` in every interactive tab. Every
 * MEETING_TICK_MS, a turn running or not, the hand asks the CLI (`hook meeting-due`) when the meetings file the CLI
 * named changed, when the time the CLI named came, or MEETING_RECHECK_MS after its last ask. The CLI marks each
 * meeting's notice stage due (before, at the slot, missed; T2405) as sent under the meetings lock, so one tab of the
 * team sends it, and starts its OS notification; the hand shows each notice it sent in the tab as a toast as well, a
 * missed one staying the longest the engine shows a toast. Nothing is typed into the terminal.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time but look-schedule.ts.
 */

import { LookSchedule } from './look-schedule.ts';

/** How often the hand looks; a look runs the CLI only when something may have changed. */
export const MEETING_TICK_MS = 30_000;
/** The longest the hand goes without asking the CLI, so a change the file does not show (a tab now a team's) is seen. */
export const MEETING_RECHECK_MS = 10 * 60_000;
/** How long one CLI run may take before it is stopped. */
export const MEETING_TIMEOUT_MS = 30_000;

/** The longest Claude Code shows a toast: its `ui.toast` drops one whose timeoutMs is over this (the engine's host check). */
export const TOAST_MAX_MS = 60_000;

/** The command line that runs the plugin's CLI as `hook meeting-due`, given the plugin's folder. */
export function meetingCliArgv(pluginRoot: string): readonly string[] {
  return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', 'meeting-due'];
}

/**
 * A notification the CLI sent (src/meeting/notify.ts MeetingNotice): its stage (before, start or missed, T2405) and
 * how long the tab's toast stays, null for Claude Code's default. The stage is plain text here, so the mod imports
 * nothing of the CLI's at run time.
 */
export interface MeetingNotice {
  readonly id: string;
  readonly stage: string;
  readonly title: string;
  readonly text: string;
  readonly stayMs: number | null;
}

/** What `hook meeting-due` answers (src/cli/commands/hook-meeting-due.ts). */
export type MeetingDueAnswer =
  | { readonly kind: 'due'; readonly notices: readonly MeetingNotice[]; readonly watch: readonly string[]; readonly recheckAt: number | null }
  | { readonly kind: 'off'; readonly why: string };

/** What a finished CLI run gave back. */
export interface MeetingRun {
  readonly exitCode: number;
  readonly stdout: string;
}

/** What the mod gives the hand: Claude Code's own calls, so the hand itself is plain code. */
export interface MeetingHandHost {
  /** The tab's Claude Code session id now (a /clear changes it). */
  sessionId(): Promise<string>;
  /** The folder the tab works in now. */
  cwd(): Promise<string>;
  /** The project root the tab started in. */
  root(): Promise<string>;
  /** Runs `hook meeting-due` in `cwd`, `env` set over Claude Code's own; rejects when it cannot start. */
  cli(stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<MeetingRun>;
  /** When the file last changed, epoch ms; undefined when it is missing. */
  changedAt(path: string): Promise<number | undefined>;
  /** Shows the person a toast for stayMs, or Claude Code's default time when null. */
  toast(text: string, stayMs: number | null): void;
  now(): number;
}

/** What one tick did. */
export type MeetingTick =
  /** The tick before still runs. */
  | { readonly kind: 'overlap' }
  /** Nothing changed since the last ask, and nothing falls due. */
  | { readonly kind: 'quiet' }
  /** The CLI sent nothing now; it names when to ask again, if it knows. */
  | { readonly kind: 'waiting'; readonly recheckAt: number | null }
  | { readonly kind: 'off'; readonly why: string }
  /** The CLI sent these meetings' notifications, and the tab showed each. */
  | { readonly kind: 'notified'; readonly ids: readonly string[] }
  | { readonly kind: 'failed'; readonly error: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function noticeOf(value: unknown): MeetingNotice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, title, text } = value;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof text !== 'string') {
    return undefined;
  }
  const stage = stageOf(value['stage']);
  const stayMs = stayOf(value['stayMs']);
  return stage === undefined || stayMs === undefined ? undefined : { id, stage, title, text, stayMs };
}

/** A notice's stage; a CLI older than the stages (T2405) sends none, and its only notice was the one at the slot. */
function stageOf(value: unknown): string | undefined {
  if (value === undefined) {
    return 'start';
  }
  return typeof value === 'string' ? value : undefined;
}

/** How long a toast stays; an older CLI sends none, so the toast keeps Claude Code's default. */
function stayOf(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function noticesOf(value: unknown): readonly MeetingNotice[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const notices = value.flatMap((item) => {
    const notice = noticeOf(item);
    return notice === undefined ? [] : [notice];
  });
  return notices.length === value.length ? notices : undefined;
}

/** The CLI's answer; undefined for anything else. */
export function parseMeetingDueAnswer(stdout: string): MeetingDueAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { kind, watch, recheckAt, why } = value;
  const notices = noticesOf(value['notices']);
  if (kind === 'due' && notices !== undefined && isTextList(watch) && (recheckAt === null || (typeof recheckAt === 'number' && Number.isFinite(recheckAt)))) {
    return { kind, notices, watch, recheckAt };
  }
  if (kind === 'off' && typeof why === 'string') {
    return { kind, why };
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MeetingHand {
  private readonly host: MeetingHandHost;
  private readonly looks: LookSchedule;
  private checking = false;

  constructor(host: MeetingHandHost) {
    this.host = host;
    this.looks = new LookSchedule(MEETING_RECHECK_MS, (path) => host.changedAt(path));
  }

  /** One look; never rejects. A running turn does not hold it: the owner hears of a meeting at its time. */
  async tick(): Promise<MeetingTick> {
    if (this.checking) {
      return { kind: 'overlap' };
    }
    this.checking = true;
    try {
      return await this.step();
    } catch (error) {
      return { kind: 'failed', error: messageOf(error) };
    } finally {
      this.checking = false;
    }
  }

  private async step(): Promise<MeetingTick> {
    if (!(await this.looks.due(this.host.now()))) {
      return { kind: 'quiet' };
    }
    const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
    const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root };
    const run = await this.host.cli(JSON.stringify({ session_id: sessionId, cwd }), env, cwd);
    const answer = run.exitCode === 0 ? parseMeetingDueAnswer(run.stdout) : undefined;
    if (answer === undefined) {
      return { kind: 'failed', error: `hook meeting-due exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}` };
    }
    if (answer.kind === 'off') {
      return answer;
    }
    this.looks.waitFor(answer.watch, answer.recheckAt);
    if (answer.notices.length === 0) {
      return { kind: 'waiting', recheckAt: answer.recheckAt };
    }
    for (const notice of answer.notices) {
      // A CLI asking a longer stay than the engine allows still gets its toast, for the longest the engine shows one.
      this.host.toast(`${notice.title}: ${notice.text}`, notice.stayMs === null ? null : Math.min(notice.stayMs, TOAST_MAX_MS));
    }
    return { kind: 'notified', ids: answer.notices.map((notice) => notice.id) };
  }
}
