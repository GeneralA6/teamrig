/**
 * The tab's side of the update notice (T2466). A person ran an old teamrig or teamrig-pane until they happened to
 * run `claude plugin update`, so the plugin's mod (`hooks/register.ts`) runs an `UpdateHand` in every interactive
 * tab. On Claude Code's clock, never on a turn's path, the mod ticks the hand UPDATE_FIRST_MS after it loaded, then
 * every UPDATE_EVERY_MS. A tick runs the CLI's `hook update-check`, which asks the network at most every 6 hours
 * across the machine (src/update/check.ts) and else reads its kept answer. The hand holds the updates it told of; the band above the prompt shows the first, with Update (`hook
 * update-apply`: Claude Code's own `plugin update`, then the tab's reload hand loads it) and Dismiss (`hook
 * update-dismiss`: hidden until a newer version is out). Nothing is typed into the terminal.
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
/** The command line that runs the plugin's CLI as `hook update-<command>`, given the plugin's folder. */
export function updateCliArgv(pluginRoot, command) {
    return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', `update-${command}`];
}
/** The band's line for an update. */
export function updateLine(notice) {
    return `${notice.plugin} ${notice.newest} is out (you run ${notice.installed})`;
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
    busy = false;
    constructor(host) {
        this.host = host;
    }
    /** The update the band shows: the first the CLI told of and the person has not updated or dismissed. */
    notice() {
        return this.notices[0];
    }
    /** One check; never rejects. A failed one keeps the updates shown, and the next tick asks again. */
    async tick() {
        if (this.busy) {
            return { kind: 'overlap' };
        }
        this.busy = true;
        try {
            const answer = await this.ask('check', {});
            if (answer.kind === 'notices') {
                this.notices = answer.notices;
                return { kind: 'checked', notices: answer.notices };
            }
            return { kind: 'failed', error: answer.kind === 'failed' ? answer.why : `hook update-check answered ${answer.kind}` };
        }
        catch (error) {
            return { kind: 'failed', error: messageOf(error) };
        }
        finally {
            this.busy = false;
        }
    }
    /** The band's Update: installs the shown update and tells the person how it went; never rejects. */
    async apply() {
        return this.act(async (notice) => {
            const answer = await this.ask('apply', { plugin: notice.plugin });
            if (answer.kind !== 'applied') {
                return { kind: 'failed', error: answer.kind === 'failed' ? answer.why : `hook update-apply answered ${answer.kind}` };
            }
            this.drop(notice.plugin);
            this.host.toast(`${answer.plugin} ${answer.version} installed: the tab reloads it`);
            return answer;
        }, 'update');
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
        }, 'dismiss');
    }
    /** Runs one press on the shown update, one at a time, toasting a failure. */
    async act(press, what) {
        const notice = this.notice();
        if (this.busy || notice === undefined) {
            return { kind: 'idle' };
        }
        this.busy = true;
        try {
            const done = await press(notice);
            if (done.kind === 'failed') {
                this.host.toast(`${notice.plugin} ${what} failed: ${done.error}`);
            }
            return done;
        }
        catch (error) {
            const failed = { kind: 'failed', error: messageOf(error) };
            this.host.toast(`${notice.plugin} ${what} failed: ${failed.error}`);
            return failed;
        }
        finally {
            this.busy = false;
        }
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
