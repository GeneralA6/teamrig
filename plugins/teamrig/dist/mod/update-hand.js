/**
 * The tab's side of the update notice (T2466). A person ran an old teamrig or teamrig-pane until they happened to
 * run `claude plugin update`, so the plugin's mod (`hooks/register.ts`) runs an `UpdateHand` in every interactive
 * tab. On Claude Code's clock, never on a turn's path, the mod ticks the hand UPDATE_FIRST_MS after it loaded, then
 * every UPDATE_EVERY_MS. A tick runs the CLI's `hook update-check`, which asks the network at most every 6 hours
 * across the machine (src/update/check.ts) and else reads its kept answer. The hand holds the updates it told of; the band above the prompt shows the first, with Update (`hook
 * update-apply`: Claude Code's own `plugin update`, then the tab's reload hand loads it) and Dismiss (`hook
 * update-dismiss`: hidden until a newer version is out). Nothing is typed into the terminal.
 *
 * The band answers a press at once (T2514): "updating" while the install runs, then "updated, reloading" for
 * UPDATED_SHOW_MS, or the failure with Update to try again. Every UPDATE_WATCH_MS the hand dates Claude Code's
 * installed_plugins.json, and a change runs a check at once, so an update made in any tab (or by `claude plugin
 * update`) hides the band in every other tab within seconds, not at its next 10-minute check.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time.
 */
/** How long after the mod loads the hand asks first, so a tab's start is left alone. */
export const UPDATE_FIRST_MS = 60_000;
/** How long the hand goes between asks; the CLI asks the network far less often. */
export const UPDATE_EVERY_MS = 10 * 60_000;
/** How long a check or a dismissal may take: a check may fetch both marketplaces. */
export const UPDATE_CHECK_TIMEOUT_MS = 90_000;
/** How long an update may take: Claude Code's marketplace update, then its plugin update. */
export const UPDATE_APPLY_TIMEOUT_MS = 400_000;
/** How often the hand dates installed_plugins.json: a stat only, so a change made by any tab shows within seconds. */
export const UPDATE_WATCH_MS = 5_000;
/** How long the band says an update is installed, before it hides (the reload hand then loads the new version). */
export const UPDATED_SHOW_MS = 30_000;
/** The command line that runs the plugin's CLI as `hook update-<command>`, given the plugin's folder. */
export function updateCliArgv(pluginRoot, command) {
    return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', `update-${command}`];
}
/** The band's line for an update. */
export function updateLine(notice) {
    return `${notice.plugin} ${notice.newest} is out (you run ${notice.installed})`;
}
/** The most of a failure's reason the band shows; the toast and the debug log carry it whole. */
const BAND_WHY_CHARS = 80;
/** The band for a view: green while an update is out, installing or installed; red with Update again after a failure. */
export function updateBandOf(view) {
    switch (view.kind) {
        case 'available':
            return { text: `teamrig: ${updateLine(view.notice)}`, color: 'success', buttons: ['update', 'dismiss'] };
        case 'updating':
            return { text: `teamrig: updating ${view.notice.plugin} to ${view.notice.newest}...`, color: 'success', buttons: [] };
        case 'updated':
            return { text: `teamrig: updated to ${view.plugin} ${view.version}, reloading`, color: 'success', buttons: [] };
        case 'failed': {
            const why = view.why.length > BAND_WHY_CHARS ? `${view.why.slice(0, BAND_WHY_CHARS - 3)}...` : view.why;
            return { text: `teamrig: ${view.notice.plugin} ${view.notice.newest} update failed: ${why}`, color: 'error', buttons: ['update', 'dismiss'] };
        }
    }
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function noticeOf(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const { plugin, marketplace, installed, newest } = value;
    return typeof plugin === 'string' && typeof marketplace === 'string' && typeof installed === 'string' && typeof newest === 'string'
        ? { plugin, marketplace, installed, newest }
        : undefined;
}
function noticesOf(value) {
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
export function parseUpdateAnswer(stdout) {
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
    const { kind, plugin, version, why } = value;
    const notices = noticesOf(value['notices']);
    if (kind === 'notices' && notices !== undefined) {
        return { kind, notices };
    }
    if (kind === 'dismissed') {
        return { kind };
    }
    if (kind === 'applied' && typeof plugin === 'string' && typeof version === 'string') {
        return { kind, plugin, version };
    }
    if (kind === 'failed' && typeof why === 'string') {
        return { kind, why };
    }
    return undefined;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export class UpdateHand {
    host;
    notices = [];
    checking = false;
    acting = false;
    /** Raised by each press, so a check that started before it drops its answer, read before the press changed things. */
    presses = 0;
    pending;
    updated;
    /** When installed_plugins.json changed as the last check after a look found it; undefined before the first look. */
    seenChangedAt;
    constructor(host) {
        this.host = host;
    }
    /** What the band shows at `now` (host.now()): an update just installed for UPDATED_SHOW_MS, else the first update the CLI told of. */
    view(now) {
        if (this.updated !== undefined && now - this.updated.at < UPDATED_SHOW_MS) {
            return { kind: 'updated', plugin: this.updated.plugin, version: this.updated.version };
        }
        const notice = this.notices[0];
        if (notice === undefined) {
            return undefined;
        }
        const pending = this.pending?.plugin === notice.plugin ? this.pending : undefined;
        if (pending?.kind === 'updating') {
            return { kind: 'updating', notice };
        }
        return pending?.kind === 'failed' ? { kind: 'failed', notice, why: pending.why } : { kind: 'available', notice };
    }
    /** One check; never rejects. A failed one keeps the updates shown, and the next tick asks again. */
    async tick() {
        if (this.checking || this.acting) {
            return { kind: 'overlap' };
        }
        this.checking = true;
        const presses = this.presses;
        try {
            const answer = await this.ask('check', {});
            if (answer.kind !== 'notices') {
                return { kind: 'failed', error: answer.kind === 'failed' ? answer.why : `hook update-check answered ${answer.kind}` };
            }
            if (presses !== this.presses) {
                return { kind: 'overlap' };
            }
            this.notices = answer.notices;
            if (this.pending !== undefined && !answer.notices.some((each) => each.plugin === this.pending?.plugin)) {
                this.pending = undefined;
            }
            this.host.changed();
            return { kind: 'checked', notices: answer.notices };
        }
        catch (error) {
            return { kind: 'failed', error: messageOf(error) };
        }
        finally {
            this.checking = false;
        }
    }
    /**
     * One look at installed_plugins.json; never rejects. The first look only notes its date; a later date runs a check
     * at once, so an update made anywhere hides the band here. A check that could not run leaves the date unseen, and
     * the next look tries again.
     */
    async watch() {
        let changedAt;
        try {
            changedAt = await this.host.installedChangedAt();
        }
        catch {
            changedAt = undefined;
        }
        if (changedAt === undefined || changedAt === this.seenChangedAt) {
            return { kind: 'unchanged' };
        }
        if (this.seenChangedAt === undefined) {
            this.seenChangedAt = changedAt;
            return { kind: 'unchanged' };
        }
        const tick = await this.tick();
        if (tick.kind !== 'overlap') {
            this.seenChangedAt = changedAt;
        }
        return { kind: 'changed', tick };
    }
    /** The band's Update: shows "updating" at once, installs the shown update and shows how it went; never rejects. */
    async apply() {
        return this.act(async (notice) => {
            const answer = await this.ask('apply', { plugin: notice.plugin });
            if (answer.kind !== 'applied') {
                return { kind: 'failed', error: answer.kind === 'failed' ? answer.why : `hook update-apply answered ${answer.kind}` };
            }
            // Dated before the drop, so no redraw between them shows the next update for a moment.
            const at = await this.host.now();
            this.drop(notice.plugin);
            this.updated = { plugin: answer.plugin, version: answer.version, at };
            this.host.toast(`${answer.plugin} ${answer.version} installed: the tab reloads it`);
            return answer;
        }, 'update', true);
    }
    /** The band's Dismiss: hides the shown update until a newer version is out; never rejects. */
    async dismiss() {
        return this.act(async (notice) => {
            const answer = await this.ask('dismiss', { plugin: notice.plugin, version: notice.newest });
            if (answer.kind !== 'dismissed') {
                return { kind: 'failed', error: answer.kind === 'failed' ? answer.why : `hook update-dismiss answered ${answer.kind}` };
            }
            this.drop(notice.plugin);
            return { kind: 'dismissed', plugin: notice.plugin, version: notice.newest };
        }, 'dismiss', false);
    }
    /**
     * Runs one press on the shown update, one at a time; a check still running does not hold it. An update shows as
     * updating while it runs and as failed after a failure, which a toast names too.
     */
    async act(press, what, installs) {
        const view = this.view(await this.host.now());
        if (this.acting || view === undefined || (view.kind !== 'available' && view.kind !== 'failed')) {
            return { kind: 'idle' };
        }
        const { notice } = view;
        this.acting = true;
        this.presses += 1;
        if (installs) {
            this.pending = { kind: 'updating', plugin: notice.plugin };
            this.host.changed();
        }
        let done;
        try {
            done = await press(notice);
        }
        catch (error) {
            done = { kind: 'failed', error: messageOf(error) };
        }
        finally {
            this.acting = false;
        }
        if (done.kind === 'failed') {
            this.host.toast(`${notice.plugin} ${what} failed: ${done.error}`);
            if (installs) {
                this.pending = { kind: 'failed', plugin: notice.plugin, why: done.error };
            }
        }
        else if (this.pending?.plugin === notice.plugin) {
            this.pending = undefined;
        }
        this.host.changed();
        return done;
    }
    drop(plugin) {
        this.notices = this.notices.filter((each) => each.plugin !== plugin);
    }
    async ask(command, request) {
        const run = await this.host.cli(command, JSON.stringify(request));
        const answer = run.exitCode === 0 ? parseUpdateAnswer(run.stdout) : undefined;
        if (answer === undefined) {
            throw new Error(`hook update-${command} exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}`);
        }
        return answer;
    }
}
