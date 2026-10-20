/**
 * The tab's side of a plugin update. `claude plugin update` installs a new version into Claude Code's plugin cache
 * and records it in `installed_plugins.json`, but an open tab runs what it loaded until `/reload-plugins` ("activate
 * pending plugin changes in the current session"). The plugin's mod (`hooks/register.ts`) runs a `ReloadHand` in
 * every interactive tab. When the mod loads, the hand takes the fingerprint of the installs that apply to the tab;
 * it reads the file again every CHECK_MS, and once an install changed (teamrig's, the pane's or any other plugin's),
 * the file has read the same for SETTLE_MS, no turn runs and nothing in the plugin store changed for SETTLE_MS
 * either (an install still being copied), it runs /reload-plugins the way the person would. It runs at most one
 * reload per RELOAD_GAP_MS, waits as long after a refused one, and never runs two for the same installs.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing from Node, only the plugin list's reader
 * (`core/installed-plugins.ts`), which imports none either: they compile to modules the mod imports as they are.
 */
import { appliesTo, INSTALLED_PLUGINS_FILE, installsOf } from "../core/installed-plugins.js";
/** How often the hand reads installed_plugins.json. */
export const CHECK_MS = 15_000;
/**
 * How long the file, and the plugin store, must stand still before a reload, so updating several plugins in a row is
 * one reload and an install's copy into the cache (about 1.4 s for teamrig) is over.
 */
export const SETTLE_MS = 10_000;
/** The least time between two reloads in one tab, and the wait after a refused one. */
export const RELOAD_GAP_MS = 5 * 60_000;
/** The command the hand runs: Claude Code's own `/reload-plugins`. */
export const RELOAD_COMMAND = 'reload-plugins';
/** The marketplace list, beside installed_plugins.json, which a marketplace update rewrites as it ends. */
export const KNOWN_MARKETPLACES_FILE = 'known_marketplaces.json';
/** The most folders of the installs one look at the store reads, so a large install keeps the look bounded. */
export const STORE_FOLDERS_MAX = 500;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function isReloadRecord(value) {
    return (isRecord(value) && typeof value['fingerprint'] === 'string' && typeof value['at'] === 'number' && Number.isFinite(value['at']));
}
/**
 * The installs that apply to a tab whose project root is `projectRoot`: every user-scope install and the project- and
 * local-scope ones for that project. Undefined for a text that is not installed_plugins.json's shape.
 */
function applyingInstalls(text, projectRoot) {
    return installsOf(text)?.filter(({ install }) => appliesTo(install, projectRoot));
}
function fingerprintOf(installs) {
    return installs
        .map(({ key, install }) => JSON.stringify([key, install.installPath, install.version, install.gitCommitSha]))
        .sort()
        .join('\n');
}
/**
 * The installs that apply to a tab whose project root is `projectRoot`, each as its plugin, folder, version and
 * commit, sorted. Undefined for a text that is not installed_plugins.json's shape, so a file mid-write or of another
 * version reads as no change.
 */
export function installedFingerprint(text, projectRoot) {
    const installs = applyingInstalls(text, projectRoot);
    return installs === undefined ? undefined : fingerprintOf(installs);
}
/** The folder that holds a path: what comes before its last `/` or `\`. */
export function parentOf(path) {
    const trimmed = path.replace(/[\\/]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return cut <= 0 ? trimmed : trimmed.slice(0, cut);
}
/**
 * The newest of `times` less than SETTLE_MS from `now` either way: a time a little ahead of the clock is a change
 * now, while one far ahead (the clock set back since) never holds reloads for good. Undefined when none is.
 */
export function newestNear(times, now) {
    const near = times.filter((time) => Math.abs(now - time) < SETTLE_MS);
    return near.length === 0 ? undefined : Math.max(...near);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
export class ReloadHand {
    host;
    /** The installs this tab runs: taken when the mod loads (or at the first file it can read), and after each reload. */
    loaded;
    /** The file's text at the last read, and since when it has read so. */
    lastText;
    sameSince = 0;
    /** The installs the hand ran a reload for, so it never runs a second one for them. */
    reloadedFor = new Set();
    /** When the last reload started, or was refused: the next waits RELOAD_GAP_MS from then. */
    heldFrom;
    /** The turns running now, the main loop's and subagents' alike, by turn id. */
    turns = new Set();
    checking = false;
    constructor(host) {
        this.host = host;
    }
    turnStarted(turnId) {
        this.turns.add(turnId);
    }
    turnEnded(turnId) {
        this.turns.delete(turnId);
    }
    /** Takes what the tab loaded and the last reload the session kept; never rejects. */
    async start() {
        const record = await this.host.recall().catch(() => undefined);
        if (isReloadRecord(record)) {
            this.reloadedFor.add(record.fingerprint);
            this.heldFrom = record.at;
        }
        this.loaded = (await this.look(this.host.now()).catch(() => undefined))?.fingerprint;
    }
    async check() {
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
        const now = this.host.now();
        const look = await this.look(now);
        if (look === undefined) {
            return { kind: 'no file' };
        }
        const { fingerprint } = look;
        if (this.loaded === undefined) {
            this.loaded = fingerprint;
            return { kind: 'no change' };
        }
        if (fingerprint === this.loaded) {
            return { kind: 'no change' };
        }
        if (this.reloadedFor.has(fingerprint)) {
            return { kind: 'reloaded before' };
        }
        if (now - this.sameSince < SETTLE_MS) {
            return { kind: 'settling' };
        }
        if (this.turns.size > 0) {
            return { kind: 'busy' };
        }
        if (this.heldFrom !== undefined && now < this.heldFrom + RELOAD_GAP_MS) {
            return { kind: 'held', until: this.heldFrom + RELOAD_GAP_MS };
        }
        const changedAt = newestNear(await this.storeTimes(look.installs), now);
        if (changedAt !== undefined) {
            return { kind: 'installing', changedAt };
        }
        return this.reloadFor(fingerprint, now);
    }
    /**
     * When each part of the store an install writes last changed, in milliseconds since the epoch: the plugin list,
     * the marketplace list, and for each install that applies to the tab its plugin's folder (a version added or
     * removed) and every folder of the install, breadth first, up to STORE_FOLDERS_MAX; a missing one is left out (its
     * plugin's folder dates a removal). `claude plugin update` creates the new version's folder, copies the plugin into
     * it and names it in the plugin list before the copy ends, and a copied file keeps its source's time, so only the
     * folders date the copy. A reload while it runs loads part of the plugin: on 10-19 one ran 0.4 s into teamrig's
     * copy and left a tab without teamrig's hooks for 15 hours (T561). Read only when a reload is otherwise due.
     */
    async storeTimes(installs) {
        const { pluginsFolder } = this.host;
        const files = [`${pluginsFolder}/${INSTALLED_PLUGINS_FILE}`, `${pluginsFolder}/${KNOWN_MARKETPLACES_FILE}`];
        const folders = installs.map(({ install }) => parentOf(install.installPath));
        let level = installs.map(({ install }) => install.installPath);
        let budget = STORE_FOLDERS_MAX;
        while (level.length > 0 && budget > 0) {
            const taken = level.slice(0, budget);
            budget -= taken.length;
            folders.push(...taken);
            level = budget > 0 ? (await Promise.all(taken.map((folder) => this.host.foldersIn(folder)))).flat() : [];
        }
        const paths = [...new Set([...files, ...folders])];
        const times = await Promise.all(paths.map((path) => this.host.changedAt(path)));
        return times.filter((time) => time !== undefined);
    }
    /**
     * Records the reload before running it, in the hand and in the session, so neither this hand nor the mod the
     * reload loads runs it again. A reload that leaves this module loaded keeps the hand, which then takes the file
     * as it reads now as loaded; a refused one waits RELOAD_GAP_MS and may run again.
     */
    async reloadFor(fingerprint, now) {
        this.reloadedFor.add(fingerprint);
        this.heldFrom = now;
        const kept = await this.host.remember({ fingerprint, at: now }).then(() => true, () => false);
        let text;
        try {
            text = await this.host.reload();
        }
        catch (error) {
            this.reloadedFor.delete(fingerprint);
            this.heldFrom = this.host.now();
            return { kind: 'refused', error: messageOf(error) };
        }
        this.loaded = (await this.look(this.host.now()).catch(() => undefined))?.fingerprint ?? fingerprint;
        return { kind: 'reloaded', text, kept };
    }
    /** Reads the file, notes since when its text has stood, and returns the installs for this tab with their fingerprint. */
    async look(now) {
        let text;
        try {
            text = await this.host.readInstalled();
        }
        catch {
            return undefined;
        }
        if (text !== this.lastText) {
            this.lastText = text;
            this.sameSince = now;
        }
        const installs = applyingInstalls(text, await this.host.projectRoot());
        return installs === undefined ? undefined : { fingerprint: fingerprintOf(installs), installs };
    }
}
