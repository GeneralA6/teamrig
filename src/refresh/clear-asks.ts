import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { stringField } from '../core/guards.ts';
import { ID_PATTERN } from '../core/ids.ts';
import { parseObject } from '../core/jsonl.ts';
import { askFileOf, CLAIM_TAKEN, CLAIM_WITHDRAWN, outcomeFileOf } from '../mod/clear-hand.ts';

/**
 * The restart's ask that a tab run /clear: which team session and which request it is for, so the claim
 * can check that request is still pending. `askedAt` makes each ask's text new, so a tab that left one
 * ask (a turn ran) still acts on the next.
 */
export interface ClearAsk {
  readonly team: string;
  readonly id: string;
  readonly at: string;
  readonly askedAt: string;
}

/**
 * The asks folder, under the kit home and not a team's: the mod knows only its Claude Code session, so
 * an ask is found by that id alone and names its team itself.
 */
export function clearAskDir(kitHome: string): string {
  return join(kitHome, 'clear-asks');
}

function parseClearAsk(text: string): ClearAsk | undefined {
  const record = parseObject(text.trim());
  if (record === undefined) {
    return undefined;
  }
  const team = stringField(record, 'team');
  const id = stringField(record, 'id');
  const at = stringField(record, 'at');
  const askedAt = stringField(record, 'askedAt');
  // The team and the id become parts of paths, so only ids pass.
  if (team === undefined || id === undefined || at === undefined || askedAt === undefined || !ID_PATTERN.test(team) || !ID_PATTERN.test(id)) {
    return undefined;
  }
  return { team, id, at, askedAt };
}

/**
 * Each Claude Code session's ask and its outcome (`<session>.ask`, `<session>.outcome`). The outcome is
 * created once (`createExclusive`): the mod's claim writes `taken`, the restart's withdraw `withdrawn`, and
 * whichever comes second learns that it lost, so a tab is never both cleared and ended. Callers check the
 * session id with `isClaudeSessionId` first; an unsafe one throws.
 */
export class ClearAsks {
  private readonly files: Files;
  private readonly dir: string;

  constructor(files: Files, dir: string) {
    this.files = files;
    this.dir = dir;
  }

  /** Posts a new ask, first removing an outcome a run that stopped before its close left, so the ask starts unclaimed. */
  async post(claudeSession: string, ask: ClearAsk): Promise<void> {
    await this.files.remove(this.outcomePath(claudeSession));
    await this.files.write(this.askPath(claudeSession), `${JSON.stringify(ask)}\n`);
  }

  /** The session's ask; undefined when there is none or it is damaged. */
  async ask(claudeSession: string): Promise<ClearAsk | undefined> {
    const text = await this.files.read(this.askPath(claudeSession));
    return text === undefined ? undefined : parseClearAsk(text);
  }

  /** True when this claim won the ask; false when the restart withdrew it first. */
  async claim(claudeSession: string): Promise<boolean> {
    return this.files.createExclusive(this.outcomePath(claudeSession), CLAIM_TAKEN);
  }

  /** True when the ask was taken back unclaimed; false when a tab claimed it first. */
  async withdraw(claudeSession: string): Promise<boolean> {
    return this.files.createExclusive(this.outcomePath(claudeSession), CLAIM_WITHDRAWN);
  }

  async taken(claudeSession: string): Promise<boolean> {
    return (await this.files.read(this.outcomePath(claudeSession)))?.trim() === CLAIM_TAKEN;
  }

  /** Removes the ask, then its outcome, so a tab looking meanwhile finds no ask before the outcome goes. */
  async close(claudeSession: string): Promise<void> {
    await this.files.remove(this.askPath(claudeSession));
    await this.files.remove(this.outcomePath(claudeSession));
  }

  private askPath(claudeSession: string): string {
    return this.checked(askFileOf(this.dir, claudeSession), claudeSession);
  }

  private outcomePath(claudeSession: string): string {
    return this.checked(outcomeFileOf(this.dir, claudeSession), claudeSession);
  }

  private checked(path: string | undefined, claudeSession: string): string {
    if (path === undefined) {
      throw new Error(`"${claudeSession}" is not a Claude Code session id`);
    }
    return path;
  }
}
