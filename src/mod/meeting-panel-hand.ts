/**
 * The tab's side of the meeting's agenda panel (T2512). While the owner meets the root team's lead, the mod
 * (`hooks/register.ts`) shows the meeting's cards as a checklist in a pane beside the lead's chat. Every
 * MEETING_PANEL_TICK_MS, a turn running or not, the hand asks the CLI (`hook meeting-panel`) once a file the CLI named
 * changed (the meeting file, each register the meeting covers) or MEETING_PANEL_RECHECK_MS after its last ask. On an
 * open meeting it opens the pane once and hands the mod the panel to draw; once the meeting ends, or the tab shows no
 * panel, it closes the pane it opened. A person's close keeps it closed until another meeting starts.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time but look-schedule.ts.
 */

import { LookSchedule } from './look-schedule.ts';

/** How often the hand looks; a look runs the CLI only when a file it watches changed. */
export const MEETING_PANEL_TICK_MS = 15_000;
/** The longest the hand goes without asking the CLI, so a change the files do not show (the config) is seen. */
export const MEETING_PANEL_RECHECK_MS = 10 * 60_000;
/** How long one CLI run may take before it is stopped. */
export const MEETING_PANEL_TIMEOUT_MS = 30_000;

/** The command line that runs the plugin's CLI as `hook meeting-panel`, given the plugin's folder. */
export function meetingPanelCliArgv(pluginRoot: string): readonly string[] {
  return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', 'meeting-panel'];
}

/** One card on the panel (src/meeting/panel.ts PanelItem). */
export interface MeetingPanelItem {
  readonly id: string;
  readonly title: string;
  readonly settled: boolean;
  readonly decision: string | null;
  /** What the card asks, in one short line, so a vague title still says what is to decide; null, nothing to add. */
  readonly summary: string | null;
}

/** The panel the mod draws (src/meeting/panel.ts MeetingPanel). */
export interface MeetingPanelView {
  readonly startedAt: string;
  readonly items: readonly MeetingPanelItem[];
  readonly current: string | null;
  readonly left: number;
}

/** What `hook meeting-panel` answers (src/cli/commands/hook-meeting-panel.ts). */
export type MeetingPanelAnswer =
  | ({ readonly kind: 'open'; readonly watch: readonly string[] } & MeetingPanelView)
  | { readonly kind: 'off'; readonly why: string; readonly watch: readonly string[] };

/** What a finished CLI run gave back. */
export interface MeetingPanelRun {
  readonly exitCode: number;
  readonly stdout: string;
}

/** What the mod gives the hand: Claude Code's own calls, so the hand itself is plain code. */
export interface MeetingPanelHost {
  /** The tab's Claude Code session id now (a /clear changes it). */
  sessionId(): Promise<string>;
  /** The folder the tab works in now. */
  cwd(): Promise<string>;
  /** The project root the tab started in. */
  root(): Promise<string>;
  /** Runs `hook meeting-panel` in `cwd`, `env` set over Claude Code's own; rejects when it cannot start. */
  cli(stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<MeetingPanelRun>;
  /** When the file last changed, epoch ms; undefined when it is missing. */
  changedAt(path: string): Promise<number | undefined>;
  /** Opens the agenda pane; opening it while it is open leaves it as it is. */
  open(): Promise<void>;
  /** Closes the agenda pane; a pane not open is left alone. */
  close(): Promise<void>;
  /** Hands the pane's drawing the panel to draw; null, none. */
  show(view: MeetingPanelView | null): Promise<void>;
  now(): number;
}

/** What one tick did. */
export type MeetingPanelTick =
  /** The tick before still runs. */
  | { readonly kind: 'overlap' }
  /** No file the hand watches changed since the last ask. */
  | { readonly kind: 'quiet' }
  /** The pane shows this panel: the card on the table and how many are left. */
  | { readonly kind: 'shown'; readonly current: string | null; readonly left: number }
  /** The person closed the pane during this meeting: it stays closed until another one starts. */
  | { readonly kind: 'dismissed' }
  /** No panel in this tab now; `closed` when the hand closed a pane for it. */
  | { readonly kind: 'off'; readonly why: string; readonly closed: boolean }
  | { readonly kind: 'failed'; readonly error: string };

/** One card as the pane draws it: its mark, title and id apart, so the drawing gives each its own line and look. */
export interface MeetingPanelCard {
  readonly mark: 'current' | 'next' | 'done';
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly decision: string | null;
}

/** A group of cards under one heading. */
export interface MeetingPanelSection {
  readonly heading: string;
  readonly cards: readonly MeetingPanelCard[];
}

/** The pane's drawing: a header line, then the sections that hold a card. */
export interface MeetingPanelLayout {
  readonly header: string;
  readonly sections: readonly MeetingPanelSection[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function itemOf(value: unknown): MeetingPanelItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, title, settled, decision, summary } = value;
  if (typeof id !== 'string' || typeof title !== 'string' || typeof settled !== 'boolean') {
    return undefined;
  }
  if (!isTextOrNull(decision) || !isTextOrNull(summary)) {
    return undefined;
  }
  return { id, title, settled, decision, summary };
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function itemsOf(value: unknown): readonly MeetingPanelItem[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.flatMap((entry) => {
    const item = itemOf(entry);
    return item === undefined ? [] : [item];
  });
  return items.length === value.length ? items : undefined;
}

/** The CLI's answer; undefined for anything else. */
export function parseMeetingPanelAnswer(stdout: string): MeetingPanelAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const { kind, watch, why, startedAt, current, left } = value;
  if (!isTextList(watch)) {
    return undefined;
  }
  if (kind === 'off' && typeof why === 'string') {
    return { kind, why, watch };
  }
  const items = itemsOf(value['items']);
  const leftOk = typeof left === 'number' && Number.isInteger(left) && left >= 0;
  if (kind === 'open' && typeof startedAt === 'string' && items !== undefined && (current === null || typeof current === 'string') && leftOk) {
    return { kind, watch, startedAt, items, current, left };
  }
  return undefined;
}

/**
 * The pane's layout (T2519): a header with how many cards are left and decided, then the card on the table, the ones
 * still to come and the decided ones, each group under its heading, in the agenda's order within it. The decided ones
 * go last, so the card on the table stays at the top as the meeting goes on; a group with no card is left out.
 */
export function panelLayout(view: MeetingPanelView): MeetingPanelLayout {
  const cards = view.items.map((item): MeetingPanelCard => ({
    mark: item.settled ? 'done' : item.id === view.current ? 'current' : 'next',
    id: item.id,
    title: item.title,
    summary: item.summary,
    decision: item.decision,
  }));
  const decided = cards.filter((card) => card.mark === 'done').length;
  const header = view.left === 0 ? 'Every card decided' : `${view.left} to decide · ${decided} decided`;
  const groups: readonly (readonly [string, MeetingPanelCard['mark']])[] = [
    ['On the table', 'current'],
    ['Up next', 'next'],
    ['Decided', 'done'],
  ];
  const sections = groups.flatMap(([heading, mark]): MeetingPanelSection[] => {
    const held = cards.filter((card) => card.mark === mark);
    return held.length === 0 ? [] : [{ heading, cards: held }];
  });
  return { header, sections };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MeetingPanelHand {
  private readonly host: MeetingPanelHost;
  private readonly looks: LookSchedule;
  private checking = false;
  /** The meeting the pane is open for; undefined, none; null at the start, as a module reloaded may find one left up. */
  private openFor: string | null | undefined = null;
  /** The meeting the person closed the pane during. */
  private closedFor: string | undefined;

  constructor(host: MeetingPanelHost) {
    this.host = host;
    this.looks = new LookSchedule(MEETING_PANEL_RECHECK_MS, (path) => host.changedAt(path));
  }

  /** The person closed the pane: it stays closed until another meeting starts. */
  personClosed(): void {
    if (typeof this.openFor === 'string') {
      this.closedFor = this.openFor;
    }
    this.openFor = undefined;
  }

  /** One look; never rejects. A running turn does not hold it: the meeting goes on while the lead works. */
  async tick(): Promise<MeetingPanelTick> {
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

  private async step(): Promise<MeetingPanelTick> {
    if (!(await this.looks.due(this.host.now()))) {
      return { kind: 'quiet' };
    }
    const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
    const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root };
    const run = await this.host.cli(JSON.stringify({ session_id: sessionId, cwd }), env, cwd);
    const answer = run.exitCode === 0 ? parseMeetingPanelAnswer(run.stdout) : undefined;
    if (answer === undefined) {
      return { kind: 'failed', error: `hook meeting-panel exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}` };
    }
    this.looks.waitFor(answer.watch, null);
    if (answer.kind === 'off') {
      const closed = this.openFor !== undefined;
      if (closed) {
        await this.host.close();
        await this.host.show(null);
        this.openFor = undefined;
      }
      return { kind: 'off', why: answer.why, closed };
    }
    const view: MeetingPanelView = { startedAt: answer.startedAt, items: answer.items, current: answer.current, left: answer.left };
    if (this.closedFor === view.startedAt) {
      return { kind: 'dismissed' };
    }
    await this.host.show(view);
    if (this.openFor !== view.startedAt) {
      await this.host.open();
      this.openFor = view.startedAt;
    }
    return { kind: 'shown', current: view.current, left: view.left };
  }
}
