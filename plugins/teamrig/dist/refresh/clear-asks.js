import { join } from 'node:path';
import { stringField } from "../core/guards.js";
import { ID_PATTERN } from "../core/ids.js";
import { parseObject } from "../core/jsonl.js";
import { askFileOf, CLAIM_END, CLAIM_HELD, CLAIM_TAKEN, CLAIM_WITHDRAWN, clearModeOf, holdWhyFileOf, outcomeFileOf, } from "../mod/clear-hand.js";
/**
 * The asks folder, under the kit home and not a team's: the mod knows only its Claude Code session, so
 * an ask is found by that id alone and names its team itself.
 */
export function clearAskDir(kitHome) {
    return join(kitHome, 'clear-asks');
}
function parseClearAsk(text) {
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
    return { team, id, at, askedAt, mode: clearModeOf(record['mode']) };
}
const OUTCOMES = [CLAIM_TAKEN, CLAIM_HELD, CLAIM_WITHDRAWN, CLAIM_END];
function outcomeOf(text) {
    return OUTCOMES.find((outcome) => outcome === text.trim());
}
/** The most of a hold's reason kept: one line, enough for any reason the mod gives. */
export const HOLD_WHY_MAX_CHARS = 200;
/** A hold's reason as one line of at most HOLD_WHY_MAX_CHARS; empty when it says nothing. */
function holdWhyLine(why) {
    return why.replace(/\s+/g, ' ').trim().slice(0, HOLD_WHY_MAX_CHARS);
}
/**
 * Each Claude Code session's ask and its outcome (`<session>.ask`, `<session>.outcome`). The outcome is
 * created once (`createExclusive`): the mod's claim writes `taken`, its hold (a helper, a draft, the person
 * or the band's count) `held`, the restart's withdraw `withdrawn`, and whichever comes later learns that it
 * lost, so a tab is never both cleared and ended, nor ended while it held the ask. A hold's reason goes in
 * `<session>.held` first, so the restart reads it once it sees `held`. Callers check the session id with
 * `isClaudeSessionId` first; an unsafe one throws.
 */
export class ClearAsks {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    /** Posts a new ask, first removing an outcome (and hold reason) a run that stopped before its close left, so the ask starts unclaimed. */
    async post(claudeSession, ask) {
        await this.files.remove(this.outcomePath(claudeSession));
        await this.files.remove(this.holdWhyPath(claudeSession));
        await this.files.write(this.askPath(claudeSession), `${JSON.stringify(ask)}\n`);
    }
    /** The session's ask; undefined when there is none or it is damaged. */
    async ask(claudeSession) {
        const text = await this.files.read(this.askPath(claudeSession));
        return text === undefined ? undefined : parseClearAsk(text);
    }
    /** True when this claim won the ask; false when it was answered first (the restart withdrew it). */
    async claim(claudeSession) {
        return this.files.createExclusive(this.outcomePath(claudeSession), CLAIM_TAKEN);
    }
    /** True when this claim won an ask in `end` mode, so the restart ends the session and the tab runs no /clear; false when it was answered first. */
    async claimEnd(claudeSession) {
        return this.files.createExclusive(this.outcomePath(claudeSession), CLAIM_END);
    }
    /**
     * True when this hold won the ask, so the restart neither clears nor ends the session; false when it was
     * answered first. `why`, the mod's reason, is written before the outcome, so it is there when the restart
     * sees `held`.
     */
    async hold(claudeSession, why) {
        const line = why === undefined ? '' : holdWhyLine(why);
        if (line !== '') {
            await this.files.write(this.holdWhyPath(claudeSession), `${line}\n`);
        }
        return this.files.createExclusive(this.outcomePath(claudeSession), CLAIM_HELD);
    }
    /** Why the tab held the ask; undefined when it gave no reason (a mod older than the reason) or did not hold it. */
    async heldWhy(claudeSession) {
        const line = holdWhyLine((await this.files.read(this.holdWhyPath(claudeSession))) ?? '');
        return line === '' ? undefined : line;
    }
    /** True when the ask was taken back unanswered; false when a tab claimed or held it first. */
    async withdraw(claudeSession) {
        return this.files.createExclusive(this.outcomePath(claudeSession), CLAIM_WITHDRAWN);
    }
    /** How the ask was answered; undefined while it is not (or the outcome is damaged). */
    async outcome(claudeSession) {
        const text = await this.files.read(this.outcomePath(claudeSession));
        return text === undefined ? undefined : outcomeOf(text);
    }
    /** Removes the ask, then its outcome and hold reason, so a tab looking meanwhile finds no ask before the outcome goes. */
    async close(claudeSession) {
        await this.files.remove(this.askPath(claudeSession));
        await this.files.remove(this.outcomePath(claudeSession));
        await this.files.remove(this.holdWhyPath(claudeSession));
    }
    askPath(claudeSession) {
        return this.checked(askFileOf(this.dir, claudeSession), claudeSession);
    }
    outcomePath(claudeSession) {
        return this.checked(outcomeFileOf(this.dir, claudeSession), claudeSession);
    }
    holdWhyPath(claudeSession) {
        return this.checked(holdWhyFileOf(this.dir, claudeSession), claudeSession);
    }
    checked(path, claudeSession) {
        if (path === undefined) {
            throw new Error(`"${claudeSession}" is not a Claude Code session id`);
        }
        return path;
    }
}
