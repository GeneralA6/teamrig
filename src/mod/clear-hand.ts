/**
 * The tab's side of a refresh by /clear. The hidden restart runner (`refresh/restart.ts`) stays the brain:
 * once the session has been quiet for the whole delay it writes an ask for the tab's Claude Code session.
 * The plugin's mod (`hooks/register.ts`) runs a `ClearHand` in every interactive tab. The hand looks for
 * that ask each tick. While a turn runs it leaves the ask (`busy`). Otherwise it asks Claude Code for the
 * session's agents (`$.agent.list()`): while one is live (any status but completed, failed or killed, an
 * idle teammate included), or when the list fails, it answers `held` through the CLI (`hook clear-claim
 * --hold`) and runs no /clear, so the runner waits and asks again instead of ending the process, which
 * would take the helper with it. Else it claims the ask through the CLI (`hook clear-claim`; both check
 * that the restart is still pending) and on a claim runs /clear the way the person would. Claude Code then
 * runs the SessionStart `clear` hooks that read the handover and wake the session.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time: it compiles to
 * a module the mod imports as it is, and the CLI shares its file names from here.
 */

/** How often the mod's hand looks for an ask. */
export const TICK_MS = 1_000;
/** How long the hand waits before it asks the CLI for the ask folder again after that failed. */
export const DIR_RETRY_MS = 60_000;
/** What `hook clear-claim` prints when this tab took the ask; anything else is a reason it did not. */
export const CLAIM_TAKEN = 'taken';
/** What `hook clear-claim --hold` prints when this tab held the ask: the session still runs a helper. */
export const CLAIM_HELD = 'held';
/** What the runner writes when it takes its ask back unclaimed. */
export const CLAIM_WITHDRAWN = 'withdrawn';
/** The switch that makes `hook clear-claim` hold the ask instead of claiming it. */
export const HOLD_SWITCH = 'hold';

/** An ask's answer in its outcome file: whichever of the three is written first wins. */
export type ClaimOutcome = typeof CLAIM_TAKEN | typeof CLAIM_HELD | typeof CLAIM_WITHDRAWN;

/** The statuses of an agent whose loop has ended (Claude Code's `AgentStatus`); every other one is live. */
const ENDED_AGENT_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed']);

/**
 * How many of the session's agents (`$.agent.list()`) are live: pending, running, waiting, idle or any status
 * this file does not know, so a /clear never cuts off a helper or a teammate that may yet act.
 */
export function liveAgentsOf(agents: readonly { readonly status: string }[]): number {
  return agents.filter((agent) => !ENDED_AGENT_STATUSES.has(agent.status)).length;
}

/** A Claude Code session id as it may appear in a file name: letters, digits and dashes only. */
const CLAUDE_SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export function isClaudeSessionId(value: string): boolean {
  return CLAUDE_SESSION_ID.test(value);
}

/** The ask for one Claude Code session in the ask folder; undefined for an id unsafe in a file name. */
export function askFileOf(dir: string, claudeSession: string): string | undefined {
  return isClaudeSessionId(claudeSession) ? `${dir}/${claudeSession}.ask` : undefined;
}

/** How the ask was answered, `taken`, `held` or `withdrawn`, created once: the first writer wins and the other learns it lost. */
export function outcomeFileOf(dir: string, claudeSession: string): string | undefined {
  return isClaudeSessionId(claudeSession) ? `${dir}/${claudeSession}.outcome` : undefined;
}

/** A CLI run's result, as the mod reads it. */
export interface CliRun {
  readonly exitCode: number;
  readonly stdout: string;
}

/** What the mod gives the hand: Claude Code's own calls, so the hand itself is plain code. */
export interface ClearHandHost {
  /** The tab's Claude Code session id now: a /clear gives the tab a new one. */
  sessionId(): Promise<string>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Runs the teamrig CLI with these arguments and this standard input. */
  cli(args: readonly string[], stdin: string): Promise<CliRun>;
  /** How many of the session's agents (subagents, teammates) are live (`liveAgentsOf`); rejects when Claude Code would not tell. */
  liveAgents(): Promise<number>;
  /** Runs /clear in the tab, as if the person typed it. */
  clear(): Promise<void>;
  now(): number;
}

/** What one tick did. */
export type TickResult =
  /** No ask folder yet: the CLI did not give one, and it is asked again after DIR_RETRY_MS. */
  | { readonly kind: 'no folder' }
  /** No new ask for this tab. */
  | { readonly kind: 'no ask' }
  /** A turn runs, so the hand leaves this ask: the runner takes it back and asks again once the session is quiet. */
  | { readonly kind: 'busy' }
  | { readonly kind: 'declined'; readonly why: string }
  /** The session still runs a helper, or Claude Code would not list its agents: the hand held the ask and ran no /clear. */
  | { readonly kind: 'held'; readonly why: string }
  | { readonly kind: 'cleared' }
  /** The tick before still runs (a /clear waits for a turn in progress). */
  | { readonly kind: 'overlap' }
  | { readonly kind: 'failed'; readonly error: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the CLI ran and printed `expected`, the one answer that lets the hand act. */
function answered(run: CliRun, expected: string): boolean {
  return run.exitCode === 0 && run.stdout.trim() === expected;
}

/** A CLI answer that was not the one asked for: its reason, or its exit code when it printed none. */
function declined(run: CliRun): TickResult {
  const answer = run.stdout.trim();
  return { kind: 'declined', why: answer === '' ? `exit ${run.exitCode}` : answer };
}

export class ClearHand {
  private readonly host: ClearHandHost;
  private dir: string | undefined;
  private dirFailedAt: number | undefined;
  /** The text of the last ask the hand acted on, so it acts on each ask once. */
  private seen: string | undefined;
  /** A turn runs: from turn.start to turn.complete. */
  private busy = false;
  private ticking = false;

  constructor(host: ClearHandHost) {
    this.host = host;
  }

  turnStarted(): void {
    this.busy = true;
  }

  turnEnded(): void {
    this.busy = false;
  }

  async tick(): Promise<TickResult> {
    if (this.ticking) {
      return { kind: 'overlap' };
    }
    this.ticking = true;
    try {
      return await this.step();
    } catch (error) {
      return { kind: 'failed', error: messageOf(error) };
    } finally {
      this.ticking = false;
    }
  }

  private async step(): Promise<TickResult> {
    const dir = await this.askDir();
    if (dir === undefined) {
      return { kind: 'no folder' };
    }
    const claudeSession = await this.host.sessionId();
    const ask = askFileOf(dir, claudeSession);
    if (ask === undefined || !(await this.host.exists(ask))) {
      return { kind: 'no ask' };
    }
    const text = await this.host.read(ask);
    if (text === this.seen) {
      return { kind: 'no ask' };
    }
    this.seen = text;
    if (this.busy) {
      return { kind: 'busy' };
    }
    const stdin = JSON.stringify({ session_id: claudeSession });
    const held = await this.heldBy();
    if (held !== undefined) {
      const hold = await this.host.cli(['hook', 'clear-claim', `--${HOLD_SWITCH}`], stdin);
      return answered(hold, CLAIM_HELD) ? { kind: 'held', why: held } : declined(hold);
    }
    const claim = await this.host.cli(['hook', 'clear-claim'], stdin);
    if (!answered(claim, CLAIM_TAKEN)) {
      return declined(claim);
    }
    await this.host.clear();
    return { kind: 'cleared' };
  }

  /** Why a /clear would cut off a helper now, or undefined when the session runs none: a list that fails counts as one. */
  private async heldBy(): Promise<string | undefined> {
    try {
      const live = await this.host.liveAgents();
      return live === 0 ? undefined : `${live} ${live === 1 ? 'agent' : 'agents'} of this session still live`;
    } catch (error) {
      return `Claude Code would not list this session's agents: ${messageOf(error)}`;
    }
  }

  /** The ask folder, asked of the CLI once (`hook clear-dir`), and again only DIR_RETRY_MS after a failure. */
  private async askDir(): Promise<string | undefined> {
    if (this.dir !== undefined) {
      return this.dir;
    }
    const now = this.host.now();
    if (this.dirFailedAt !== undefined && now - this.dirFailedAt < DIR_RETRY_MS) {
      return undefined;
    }
    const run = await this.host.cli(['hook', 'clear-dir'], '').catch(() => undefined);
    const dir = run?.exitCode === 0 ? run.stdout.trim() : '';
    if (dir === '') {
      this.dirFailedAt = now;
      return undefined;
    }
    this.dir = dir;
    return dir;
  }
}
