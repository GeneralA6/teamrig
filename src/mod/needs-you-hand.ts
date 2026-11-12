/**
 * The tab's side of the needs-you band (T2511). A tab that asks the person something (a permission prompt, a
 * question or plan, an MCP form, a `Decision needed:` line) is often not the tab the person is in, so the plugin's
 * mod (`hooks/register.ts`) runs a `NeedsYouHand` in every interactive tab. Every NEEDS_YOU_TICK_MS, a turn running
 * or not, the hand runs the CLI's `hook needs-you`, which answers the asks of the team's other tabs now, newest
 * first. Each ask the hand had not seen (a tab and the time its ask began) shows once as a toast, for the longest the
 * engine shows one; the band above the prompt names the newest ask not dismissed, with Focus (`hook
 * needs-you-focus`: brings that tab to the front; offered only when the CLI says so, as the owner's meeting holds it
 * to p0 work) and Dismiss (hides that ask in this tab). The band goes once no tab asks. Nothing is typed into the
 * terminal.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time but meeting-hand.ts.
 */

import { TOAST_MAX_MS } from './meeting-hand.ts';

/** How often the hand asks: an ask shows in the other tabs within this. */
export const NEEDS_YOU_TICK_MS = 10_000;
/** How long one CLI run may take before it is stopped: a focus runs the terminal's own script. */
export const NEEDS_YOU_TIMEOUT_MS = 30_000;
/** The most of an ask's text the band shows; the toast carries it whole. */
const BAND_TEXT_CHARS = 100;

/** The CLI commands the hand runs: `hook needs-you` and `hook needs-you-focus`. */
export type NeedsYouCommand = 'needs-you' | 'needs-you-focus';

/** The command line that runs the plugin's CLI as `hook <command>`, given the plugin's folder. */
export function needsYouCliArgv(pluginRoot: string, command: NeedsYouCommand): readonly string[] {
  return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', command];
}

/**
 * Another tab's ask (src/cli/commands/hook-needs-you.ts ShownAsk): its session, its tab's title, what kind of ask,
 * its text, the task it names, when it began and whether the band offers Focus. Kinds are plain text here, so the mod
 * imports nothing of the CLI's at run time.
 */
export interface NeedsYouAsk {
  readonly session: string;
  readonly tab: string;
  readonly kind: string;
  readonly text: string;
  readonly task: string | null;
  readonly since: string;
  readonly focus: boolean;
}

/** What `hook needs-you` answers. */
export type NeedsYouAnswer = { readonly kind: 'asks'; readonly asks: readonly NeedsYouAsk[] } | { readonly kind: 'off'; readonly why: string };

/** What `hook needs-you-focus` answers: the focus outcome's kind (focused, behind, none) with its line, or why it was not tried. */
export type NeedsYouFocusAnswer =
  | { readonly kind: 'focused' | 'behind' | 'none'; readonly text: string }
  | { readonly kind: 'refused' | 'off'; readonly why: string };

/** What a finished CLI run gave back. */
export interface NeedsYouRun {
  readonly exitCode: number;
  readonly stdout: string;
}

/** What the mod gives the hand: Claude Code's own calls, so the hand itself is plain code. */
export interface NeedsYouHandHost {
  /** The tab's Claude Code session id now (a /clear changes it). */
  sessionId(): Promise<string>;
  /** The folder the tab works in now. */
  cwd(): Promise<string>;
  /** The project root the tab started in. */
  root(): Promise<string>;
  /** Runs `hook <command>` in `cwd`, `env` set over Claude Code's own; rejects when it cannot start. */
  cli(command: NeedsYouCommand, stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<NeedsYouRun>;
  /** Shows the person a toast for stayMs. */
  toast(text: string, stayMs: number): void;
  /** Redraws the band: what view() gives changed. */
  changed(): void;
}

/** What the band shows (types/index.d.ts TeamrigNeedsYou): the newest ask not dismissed, and how many more there are. */
export interface NeedsYouView {
  readonly session: string;
  readonly since: string;
  readonly tab: string;
  readonly text: string;
  readonly focus: boolean;
  readonly more: number;
}

/** What one tick did. */
export type NeedsYouTick =
  /** The tick before, or a Focus, still runs. */
  | { readonly kind: 'overlap' }
  /** The CLI answered these asks; `fresh` names the sessions whose ask the tab toasted now. */
  | { readonly kind: 'asks'; readonly count: number; readonly fresh: readonly string[] }
  | { readonly kind: 'off'; readonly why: string }
  | { readonly kind: 'failed'; readonly error: string };

/** What a press of the band's Focus or Dismiss did. */
export type NeedsYouAction =
  /** No ask is shown, the shown one offers no Focus, or a Focus still runs. */
  | { readonly kind: 'idle' }
  | { readonly kind: 'dismissed'; readonly session: string }
  | { readonly kind: 'focused' | 'behind' | 'none'; readonly text: string }
  | { readonly kind: 'refused' | 'off'; readonly why: string }
  | { readonly kind: 'failed'; readonly error: string };

/** The band's line for a view: the tab, its ask cut to fit, and how many other asks wait. */
export function needsYouLine(view: NeedsYouView): string {
  const text = view.text.length > BAND_TEXT_CHARS ? `${view.text.slice(0, BAND_TEXT_CHARS - 3)}...` : view.text;
  return `${view.tab} asks: ${text}${view.more > 0 ? ` (+${view.more} more)` : ''}`;
}

/** Whether two views draw the same band. */
export function sameNeedsYou(a: NeedsYouView | null, b: NeedsYouView | null | undefined): boolean {
  if (a === null || b === null || b === undefined) {
    return a === b;
  }
  return needsYouLine(a) === needsYouLine(b) && a.focus === b.focus && a.session === b.session && a.since === b.since;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function askOf(value: unknown): NeedsYouAsk | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { session, tab, kind, text, task, since, focus } = value;
  return typeof session === 'string' &&
    typeof tab === 'string' &&
    typeof kind === 'string' &&
    typeof text === 'string' &&
    (task === null || typeof task === 'string') &&
    typeof since === 'string' &&
    typeof focus === 'boolean'
    ? { session, tab, kind, text, task, since, focus }
    : undefined;
}

function asksOf(value: unknown): readonly NeedsYouAsk[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const asks = value.flatMap((item) => {
    const ask = askOf(item);
    return ask === undefined ? [] : [ask];
  });
  return asks.length === value.length ? asks : undefined;
}

function jsonOf(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
}

/** The CLI's `hook needs-you` answer; undefined for anything else. */
export function parseNeedsYouAnswer(stdout: string): NeedsYouAnswer | undefined {
  const value = jsonOf(stdout);
  if (!isRecord(value)) {
    return undefined;
  }
  const { kind, why } = value;
  const asks = asksOf(value['asks']);
  if (kind === 'asks' && asks !== undefined) {
    return { kind, asks };
  }
  return kind === 'off' && typeof why === 'string' ? { kind, why } : undefined;
}

/** The CLI's `hook needs-you-focus` answer; undefined for anything else. */
export function parseNeedsYouFocusAnswer(stdout: string): NeedsYouFocusAnswer | undefined {
  const value = jsonOf(stdout);
  if (!isRecord(value)) {
    return undefined;
  }
  const { kind, text, why } = value;
  if ((kind === 'focused' || kind === 'behind' || kind === 'none') && typeof text === 'string') {
    return { kind, text };
  }
  return (kind === 'refused' || kind === 'off') && typeof why === 'string' ? { kind, why } : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One ask's key: a tab's new ask begins at a new time, so it toasts again and a dismissal of the old one ends. */
function keyOf(ask: { readonly session: string; readonly since: string }): string {
  return `${ask.session}@${ask.since}`;
}

export class NeedsYouHand {
  private readonly host: NeedsYouHandHost;
  private asks: readonly NeedsYouAsk[] = [];
  /** The asks toasted and dismissed in this tab, kept only while the CLI still answers them. */
  private toasted = new Set<string>();
  private dismissed = new Set<string>();
  private checking = false;
  private focusing = false;

  constructor(host: NeedsYouHandHost) {
    this.host = host;
  }

  /** What the band shows: the newest ask not dismissed, or undefined. */
  view(): NeedsYouView | undefined {
    const open = this.asks.filter((ask) => !this.dismissed.has(keyOf(ask)));
    const [first] = open;
    return first === undefined
      ? undefined
      : { session: first.session, since: first.since, tab: first.tab, text: first.text, focus: first.focus, more: open.length - 1 };
  }

  /** One ask of the CLI; never rejects. A failed one keeps the band as it was, and the next tick asks again. */
  async tick(): Promise<NeedsYouTick> {
    if (this.checking) {
      return { kind: 'overlap' };
    }
    this.checking = true;
    try {
      const run = await this.run('needs-you', {});
      const answer = run.exitCode === 0 ? parseNeedsYouAnswer(run.stdout) : undefined;
      if (answer === undefined) {
        return { kind: 'failed', error: `hook needs-you exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}` };
      }
      const asks = answer.kind === 'asks' ? answer.asks : [];
      const fresh = asks.filter((ask) => !this.toasted.has(keyOf(ask)));
      for (const ask of fresh) {
        this.host.toast(`${ask.tab} needs you: ${ask.text}`, TOAST_MAX_MS);
      }
      const live = new Set(asks.map(keyOf));
      this.toasted = live;
      this.dismissed = new Set([...this.dismissed].filter((key) => live.has(key)));
      this.asks = asks;
      this.host.changed();
      return answer.kind === 'off' ? answer : { kind: 'asks', count: asks.length, fresh: fresh.map((ask) => ask.session) };
    } catch (error) {
      return { kind: 'failed', error: messageOf(error) };
    } finally {
      this.checking = false;
    }
  }

  /** The band's Focus: brings the shown ask's tab to the front through the CLI, which re-checks the ask; never rejects. */
  async focus(): Promise<NeedsYouAction> {
    const view = this.view();
    if (this.focusing || view === undefined || !view.focus) {
      return { kind: 'idle' };
    }
    this.focusing = true;
    try {
      const run = await this.run('needs-you-focus', { session: view.session });
      const answer = run.exitCode === 0 ? parseNeedsYouFocusAnswer(run.stdout) : undefined;
      if (answer === undefined) {
        const error = `hook needs-you-focus exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}`;
        this.host.toast(`Focus failed: ${error}`, TOAST_MAX_MS);
        return { kind: 'failed', error };
      }
      // A tab in front needs no word; a refusal or a miss says why, as the person pressed and nothing moved.
      if (answer.kind !== 'focused') {
        this.host.toast('text' in answer ? answer.text : `Focus not run: ${answer.why}`, TOAST_MAX_MS);
      }
      return answer;
    } catch (error) {
      const failed = messageOf(error);
      this.host.toast(`Focus failed: ${failed}`, TOAST_MAX_MS);
      return { kind: 'failed', error: failed };
    } finally {
      this.focusing = false;
    }
  }

  /** The band's Dismiss: hides the shown ask in this tab until that tab asks anew. */
  dismiss(): NeedsYouAction {
    const view = this.view();
    if (view === undefined) {
      return { kind: 'idle' };
    }
    this.dismissed.add(keyOf(view));
    this.host.changed();
    return { kind: 'dismissed', session: view.session };
  }

  private async run(command: NeedsYouCommand, extra: Readonly<Record<string, string>>): Promise<NeedsYouRun> {
    const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
    const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root };
    return this.host.cli(command, JSON.stringify({ session_id: sessionId, cwd, ...extra }), env, cwd);
  }
}
