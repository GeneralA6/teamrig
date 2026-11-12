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
import { LookSchedule } from "./look-schedule.js";
/** How often the hand looks; a look runs the CLI only when a file it watches changed. */
export const MEETING_PANEL_TICK_MS = 15_000;
/** The longest the hand goes without asking the CLI, so a change the files do not show (the config) is seen. */
export const MEETING_PANEL_RECHECK_MS = 10 * 60_000;
/** How long one CLI run may take before it is stopped. */
export const MEETING_PANEL_TIMEOUT_MS = 30_000;
/** The command line that runs the plugin's CLI as `hook meeting-panel`, given the plugin's folder. */
export function meetingPanelCliArgv(pluginRoot) {
    return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', 'meeting-panel'];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isTextList(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function itemOf(value) {
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
function isTextOrNull(value) {
    return value === null || typeof value === 'string';
}
function itemsOf(value) {
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
export function parseMeetingPanelAnswer(stdout) {
    let value;
    try {
        value = JSON.parse(stdout.trim());
    }
    catch {
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
export function panelLayout(view) {
    const cards = view.items.map((item) => ({
        mark: item.settled ? 'done' : item.id === view.current ? 'current' : 'next',
        id: item.id,
        title: item.title,
        summary: item.summary,
        decision: item.decision,
    }));
    const decided = cards.filter((card) => card.mark === 'done').length;
    const header = view.left === 0 ? 'Every card decided' : `${view.left} to decide · ${decided} decided`;
    const groups = [
        ['On the table', 'current'],
        ['Up next', 'next'],
        ['Decided', 'done'],
    ];
    const sections = groups.flatMap(([heading, mark]) => {
        const held = cards.filter((card) => card.mark === mark);
        return held.length === 0 ? [] : [{ heading, cards: held }];
    });
    return { header, sections };
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export class MeetingPanelHand {
    host;
    looks;
    checking = false;
    /** The meeting the pane is open for; undefined, none; null at the start, as a module reloaded may find one left up. */
    openFor = null;
    /** The meeting the person closed the pane during. */
    closedFor;
    constructor(host) {
        this.host = host;
        this.looks = new LookSchedule(MEETING_PANEL_RECHECK_MS, (path) => host.changedAt(path));
    }
    /** The person closed the pane: it stays closed until another meeting starts. */
    personClosed() {
        if (typeof this.openFor === 'string') {
            this.closedFor = this.openFor;
        }
        this.openFor = undefined;
    }
    /** One look; never rejects. A running turn does not hold it: the meeting goes on while the lead works. */
    async tick() {
        if (this.checking) {
            return { kind: 'overlap' };
        }
        this.checking = true;
        try {
            return await this.step();
        }
        catch (error) {
            return { kind: 'failed', error: messageOf(error) };
        }
        finally {
            this.checking = false;
        }
    }
    async step() {
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
        const view = { startedAt: answer.startedAt, items: answer.items, current: answer.current, left: answer.left };
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
