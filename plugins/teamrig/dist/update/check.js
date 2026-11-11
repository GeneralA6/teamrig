/**
 * The update check behind the tab's update band (T2466): whether a newer teamrig or teamrig-pane than the installed
 * one is published in its marketplace. At most once per CHECK_EVERY_MS, across every tab of the machine, it asks each
 * marketplace for its newest commit; the answer, and the versions read from it, are kept in the kit home's
 * `updates/check.json`, so every other look reads the file only. A tab claims the check by writing its time before the
 * network is asked, so tabs that look together ask once. A marketplace that cannot be asked (offline, no access) keeps
 * what was known, and nothing shows: a failed check stays quiet until the next one.
 *
 * A cloned marketplace (github, git, url) is asked through a bare repository teamrig keeps for it, never Claude Code's
 * own clone: `git ls-remote` of the clone's `origin` names the newest commit (under 2 s), and only a commit not seen
 * before is fetched, one commit deep and without file contents (`--filter=blob:none`), so the two files read are the
 * only contents downloaded (about 4 s and 160 KB on 11-11). `git gc --prune=now` then drops the fetched objects,
 * so the repository never grows. A directory marketplace is read in place.
 */
import { join } from 'node:path';
import { isRecord } from "../core/guards.js";
import { INSTALLED_PLUGINS_FILE } from "../core/installed-plugins.js";
import { KNOWN_MARKETPLACES_FILE } from "../core/plugin-store.js";
import { compareVersions, parseVersion } from "../core/release-version.js";
import { MARKETPLACE_FILE, marketplaceSourceOf, pluginFilePath, pluginFolderOf, pluginVersionOf, trackedInstallsOf, } from "./sources.js";
/** How often the network is asked at most, across every tab of the machine. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
const STATE_FILE = 'check.json';
const EMPTY = { checkedAt: undefined, published: {}, dismissed: {} };
function textRecord(value) {
    if (!isRecord(value)) {
        return {};
    }
    return Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === 'string'));
}
function publishedRecord(value) {
    if (!isRecord(value)) {
        return {};
    }
    const entries = [];
    for (const [name, entry] of Object.entries(value)) {
        if (isRecord(entry) && typeof entry['sha'] === 'string') {
            entries.push([name, { sha: entry['sha'], versions: textRecord(entry['versions']) }]);
        }
    }
    return Object.fromEntries(entries);
}
/** The kept state; a missing file, or one of another shape, as nothing known. */
export function parseCheckState(text) {
    let value;
    try {
        value = text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        return EMPTY;
    }
    if (!isRecord(value)) {
        return EMPTY;
    }
    const checkedAt = value['checkedAt'];
    return {
        checkedAt: typeof checkedAt === 'number' && Number.isFinite(checkedAt) ? checkedAt : undefined,
        published: publishedRecord(value['published']),
        dismissed: textRecord(value['dismissed']),
    };
}
/** Whether `a` is a newer release than `b`; false when either is not a release version. */
export function isNewer(a, b) {
    const left = parseVersion(a);
    const right = parseVersion(b);
    return left !== undefined && right !== undefined && compareVersions(left, right) > 0;
}
/** The installs a newer version is published for, leaving out those the person dismissed that version or a newer one of. */
export function noticesOf(installs, state) {
    return installs.flatMap((install) => {
        const newest = state.published[install.marketplace]?.versions[install.plugin];
        if (newest === undefined || !isNewer(newest, install.version)) {
            return [];
        }
        const dismissed = state.dismissed[install.plugin];
        if (dismissed !== undefined && !isNewer(newest, dismissed)) {
            return [];
        }
        return [{ plugin: install.plugin, marketplace: install.marketplace, installed: install.version, newest }];
    });
}
/** A marketplace name as a folder name: anything but letters, digits, `.`, `_` and `-` becomes `_`. */
function folderName(marketplace) {
    return marketplace.replace(/[^A-Za-z0-9._-]/g, '_');
}
export class UpdateCheck {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    get stateFile() {
        return join(this.deps.paths.updatesFolder, STATE_FILE);
    }
    /**
     * The updates to tell of now. Asks the network first when the last check is CHECK_EVERY_MS old, or dated ahead of
     * the clock (the clock set back since), and only when a tracked plugin is installed.
     */
    async notices() {
        const installs = await this.installs();
        let state = await this.state();
        const now = this.deps.now();
        const stale = state.checkedAt === undefined || now - state.checkedAt >= CHECK_EVERY_MS || state.checkedAt > now;
        if (installs.length > 0 && stale) {
            state = await this.refresh(installs, state, now);
        }
        return noticesOf(installs, state);
    }
    /** Hides `plugin`'s update notices until a version newer than `version` is published. */
    async dismiss(plugin, version) {
        const state = await this.state();
        await this.save({ ...state, dismissed: { ...state.dismissed, [plugin]: version } });
    }
    async installs() {
        const text = await this.deps.files.read(join(this.deps.paths.pluginsFolder, INSTALLED_PLUGINS_FILE));
        return text === undefined ? [] : trackedInstallsOf(text);
    }
    async state() {
        return parseCheckState(await this.deps.files.read(this.stateFile));
    }
    async save(state) {
        await this.deps.files.write(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    }
    async refresh(installs, before, now) {
        // The claim: a tab that looks while this one asks reads a fresh check and asks nothing.
        await this.save({ ...before, checkedAt: now });
        const known = (await this.deps.files.read(join(this.deps.paths.pluginsFolder, KNOWN_MARKETPLACES_FILE))) ?? '';
        const published = { ...before.published };
        for (const marketplace of [...new Set(installs.map((install) => install.marketplace))]) {
            const source = marketplaceSourceOf(known, marketplace);
            const plugins = installs.filter((install) => install.marketplace === marketplace).map((install) => install.plugin);
            const found = source === undefined ? undefined : await this.publishedBy(marketplace, source, plugins, before.published[marketplace]);
            if (found !== undefined) {
                published[marketplace] = found;
            }
        }
        // Read again: a dismissal another tab saved while this one asked stays.
        const latest = await this.state();
        const after = { checkedAt: now, published, dismissed: latest.dismissed };
        await this.save(after);
        return after;
    }
    async publishedBy(marketplace, source, plugins, before) {
        if (source.kind === 'directory') {
            const read = (path) => this.deps.files.read(join(source.path, path));
            return this.versionsIn(read, plugins, '');
        }
        const { git } = this.deps;
        const url = (await git.run(source.installLocation, ['remote', 'get-url', 'origin']))?.trim();
        if (url === undefined || url === '') {
            return undefined;
        }
        const repo = join(this.deps.paths.updatesFolder, `${folderName(marketplace)}.git`);
        if (!(await this.ensureRepo(repo, url))) {
            return undefined;
        }
        const sha = (await git.run(repo, ['ls-remote', 'origin', 'HEAD']))?.split(/\s/)[0];
        if (sha === undefined || sha === '') {
            return undefined;
        }
        if (before?.sha === sha && plugins.every((plugin) => before.versions[plugin] !== undefined)) {
            return before;
        }
        if ((await git.run(repo, ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'HEAD'])) === undefined) {
            return undefined;
        }
        const read = (path) => git.run(repo, ['show', `FETCH_HEAD:${path}`]);
        const found = await this.versionsIn(read, plugins, sha);
        await git.run(repo, ['gc', '--prune=now', '--quiet']);
        return found;
    }
    /** Makes the bare repository once, and points its `origin` at `url` with blobs fetched on demand. */
    async ensureRepo(repo, url) {
        const { git, files } = this.deps;
        if ((await files.read(join(repo, 'HEAD'))) === undefined) {
            await files.makeFolder(repo);
            if ((await git.run(repo, ['init', '--bare', '--quiet'])) === undefined) {
                return false;
            }
        }
        for (const [key, value] of [['remote.origin.url', url], ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none']]) {
            if ((await git.run(repo, ['config', key, value])) === undefined) {
                return false;
            }
        }
        return true;
    }
    async versionsIn(read, plugins, sha) {
        const marketplace = await read(MARKETPLACE_FILE);
        if (marketplace === undefined) {
            return undefined;
        }
        const versions = {};
        for (const plugin of plugins) {
            const folder = pluginFolderOf(marketplace, plugin);
            const text = folder === undefined ? undefined : await read(pluginFilePath(folder));
            const version = text === undefined ? undefined : pluginVersionOf(text);
            if (version !== undefined) {
                versions[plugin] = version;
            }
        }
        return { sha, versions };
    }
}
