/**
 * The tab's side of the refresh within a long turn. The Stop hook asks for the handover only at a turn's end, so
 * a turn that runs past the threshold reached Claude Code's compaction first. The plugin's mod
 * (`hooks/register.ts`) runs a `RefreshHand` in every interactive tab:
 *
 * - after each tool result of the main conversation, once the context reached the size the CLI named, the hand
 *   asks the CLI (`hook refresh-mid`); an ask it answers with is added after the tool's result, which the model
 *   reads and the person does not see (src/refresh/decide.ts `decideMidTurn`);
 * - before Claude Code compacts the main conversation on its own, the hand asks the CLI (`hook compact-check`)
 *   and skips the compaction while the handover is asked for or written, up to `refresh.compactCeilingTokens`
 *   (`decideCompact`): the fresh start that follows the turn replaces it.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time: it compiles to a module
 * the mod imports as it is.
 */

/** How long one CLI run may take before it is stopped; the tool's result, or the compaction, waits for it. */
export const REFRESH_TIMEOUT_MS = 15_000;
/**
 * The least time between two asks while the CLI holds one past its size (background work the session started
 * still runs): the hand looks again at the first tool result after it.
 */
export const HOLD_GAP_MS = 60_000;
/** The longest the hand goes without asking the CLI while tools run, so a change of config is seen. */
export const RECHECK_MS = 10 * 60_000;

/** The CLI's two refresh commands. */
export type RefreshCommand = 'refresh-mid' | 'compact-check';

/** The command line that runs the plugin's CLI for one refresh command, given the plugin's folder. */
export function refreshCliArgv(pluginRoot: string, command: RefreshCommand): readonly string[] {
  return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', command];
}

/** What a finished CLI run gave back. */
export interface RefreshRun {
  readonly exitCode: number;
  readonly stdout: string;
}

/** What the mod gives the hand: Claude Code's own calls, so the hand itself is plain code. */
export interface RefreshHandHost {
  /** The tab's Claude Code session id now (a /clear changes it). */
  sessionId(): Promise<string>;
  /** The folder the tab works in now. */
  cwd(): Promise<string>;
  /** The project root the tab started in. */
  root(): Promise<string>;
  /** Runs the plugin's CLI as `hook <command>` in `cwd`, `env` set over Claude Code's own; rejects when it cannot start. */
  cli(command: RefreshCommand, stdin: string, env: Readonly<Record<string, string>>, cwd: string): Promise<RefreshRun>;
  now(): number;
}

/** What `hook refresh-mid` answers (src/cli/commands/hook-refresh-mod.ts). */
export type MidTurnAnswer =
  | { readonly kind: 'ask'; readonly text: string; readonly nextAt: number }
  | { readonly kind: 'wait'; readonly nextAt: number | null };

/** What `hook compact-check` answers. */
export type CompactAnswer = { readonly kind: 'skip'; readonly reason: string } | { readonly kind: 'go' };

/** What one tool result did. */
export type MidTurnTick =
  /** A look still runs (tools run side by side). */
  | { readonly kind: 'overlap' }
  /** The context is under the size the CLI named, and no recheck is due. */
  | { readonly kind: 'quiet' }
  /** The CLI asked for nothing now; `nextAt` is the size it asks to be asked again at, null for only at the recheck. */
  | { readonly kind: 'waiting'; readonly nextAt: number | null }
  /** The ask to add after the tool's result. */
  | { readonly kind: 'asked'; readonly text: string }
  | { readonly kind: 'failed'; readonly error: string };

/** What the hand answers Claude Code's compaction. */
export type CompactVerdict = CompactAnswer | { readonly kind: 'failed'; readonly error: string };

/** The CLI's last answer to `hook refresh-mid`, or a failed run, which waits for the recheck. */
interface LastAnswer {
  /** When the ask ran. */
  readonly at: number;
  /** The context to ask again at; null: only at the recheck. */
  readonly nextAt: number | null;
  /** It waited although the context was past its size: background work the session started runs. */
  readonly held: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function recordOf(stdout: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `hook refresh-mid`'s answer; undefined for anything else. */
export function parseMidTurnAnswer(stdout: string): MidTurnAnswer | undefined {
  const value = recordOf(stdout);
  if (value === undefined) {
    return undefined;
  }
  const { kind, text, nextAt } = value;
  if (kind === 'ask' && typeof text === 'string' && isSize(nextAt)) {
    return { kind, text, nextAt };
  }
  if (kind === 'wait' && (nextAt === null || isSize(nextAt))) {
    return { kind, nextAt };
  }
  return undefined;
}

/** `hook compact-check`'s answer; undefined for anything else. */
export function parseCompactAnswer(stdout: string): CompactAnswer | undefined {
  const value = recordOf(stdout);
  if (value === undefined) {
    return undefined;
  }
  const { kind, reason } = value;
  if (kind === 'skip' && typeof reason === 'string') {
    return { kind, reason };
  }
  return kind === 'go' ? { kind } : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RefreshHand {
  private readonly host: RefreshHandHost;
  private looking = false;
  /** The last answer, undefined to ask at the next tool result. */
  private last: LastAnswer | undefined;
  /** The context at the last tool result: one smaller means Claude Code compacted or cleared it since. */
  private lastTokens: number | undefined;

  constructor(host: RefreshHandHost) {
    this.host = host;
  }

  /** At a tool result of the main conversation, with the context the last reply read; never rejects. */
  async afterTool(tokens: number, window?: number): Promise<MidTurnTick> {
    if (this.looking) {
      return { kind: 'overlap' };
    }
    if (this.lastTokens !== undefined && tokens < this.lastTokens) {
      // A /clear or a compaction: the refresh state the CLI named a size for may have started over.
      this.last = undefined;
    }
    this.lastTokens = tokens;
    const now = this.host.now();
    if (!this.isDue(now, tokens)) {
      return { kind: 'quiet' };
    }
    this.looking = true;
    try {
      return await this.look(now, tokens, window);
    } catch (error) {
      // Not asked again at every tool result while the CLI fails: only at the recheck.
      this.last = { at: now, nextAt: null, held: false };
      return { kind: 'failed', error: messageOf(error) };
    } finally {
      this.looking = false;
    }
  }

  /** Before Claude Code compacts the main conversation on its own; never rejects, and a failure lets it compact. */
  async beforeCompact(tokens: number, window: number): Promise<CompactVerdict> {
    try {
      const run = await this.run('compact-check', { tokens, window });
      const answer = run.exitCode === 0 ? parseCompactAnswer(run.stdout) : undefined;
      return answer ?? { kind: 'failed', error: `hook compact-check exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}` };
    } catch (error) {
      return { kind: 'failed', error: messageOf(error) };
    }
  }

  private async look(now: number, tokens: number, window: number | undefined): Promise<MidTurnTick> {
    const run = await this.run('refresh-mid', window === undefined ? { tokens } : { tokens, window });
    const answer = run.exitCode === 0 ? parseMidTurnAnswer(run.stdout) : undefined;
    if (answer === undefined) {
      throw new Error(`hook refresh-mid exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}`);
    }
    if (answer.kind === 'ask') {
      this.last = { at: now, nextAt: answer.nextAt, held: false };
      return { kind: 'asked', text: answer.text };
    }
    this.last = { at: now, nextAt: answer.nextAt, held: answer.nextAt !== null && tokens >= answer.nextAt };
    return { kind: 'waiting', nextAt: answer.nextAt };
  }

  private async run(command: RefreshCommand, facts: Readonly<Record<string, number>>): Promise<RefreshRun> {
    const [sessionId, cwd, root] = await Promise.all([this.host.sessionId(), this.host.cwd(), this.host.root()]);
    const env = { CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: root };
    return this.host.cli(command, JSON.stringify({ session_id: sessionId, cwd, ...facts }), env, cwd);
  }

  /**
   * Ask the CLI at the first tool result and after a compaction or /clear, once the context reached the size it
   * named (a held ask only HOLD_GAP_MS after the last), and RECHECK_MS after the last ask.
   */
  private isDue(now: number, tokens: number): boolean {
    const { last } = this;
    if (last === undefined || now >= last.at + RECHECK_MS) {
      return true;
    }
    if (last.nextAt === null || tokens < last.nextAt) {
      return false;
    }
    return !last.held || now >= last.at + HOLD_GAP_MS;
  }
}
