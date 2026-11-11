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
import type { Files } from '../core/files.ts';
import { isRecord } from '../core/guards.ts';
import { INSTALLED_PLUGINS_FILE } from '../core/installed-plugins.ts';
import { KNOWN_MARKETPLACES_FILE } from '../core/plugin-store.ts';
import { compareVersions, parseVersion } from '../core/release-version.ts';
import {
  MARKETPLACE_FILE,
  marketplaceSourceOf,
  pluginFilePath,
  pluginFolderOf,
  pluginVersionOf,
  trackedInstallsOf,
  type MarketplaceSource,
  type TrackedInstall,
} from './sources.ts';

/** How often the network is asked at most, across every tab of the machine. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** A newer version of a plugin than the one installed, published in its marketplace. */
export interface UpdateNotice {
  readonly plugin: string;
  readonly marketplace: string;
  readonly installed: string;
  readonly newest: string;
}

/** What one marketplace published at its newest commit: the commit (empty for a directory) and each tracked plugin's version. */
export interface Published {
  readonly sha: string;
  readonly versions: Readonly<Record<string, string>>;
}

/** The kept state: the last network check, what each marketplace published then, and the versions the person dismissed. */
export interface CheckState {
  readonly checkedAt: number | undefined;
  readonly published: Readonly<Record<string, Published>>;
  readonly dismissed: Readonly<Record<string, string>>;
}

/** Runs git in a folder: its stdout when it exits 0, else undefined (not installed, offline, no access, its time limit). */
export interface UpdateGit {
  run(cwd: string, args: readonly string[]): Promise<string | undefined>;
}

/** Where the check reads and keeps its files. */
export interface UpdatePaths {
  /** Claude Code's `plugins` folder, which holds installed_plugins.json and known_marketplaces.json. */
  readonly pluginsFolder: string;
  /** The kit home's `updates` folder: check.json and a bare repository per cloned marketplace. */
  readonly updatesFolder: string;
}

export interface UpdateCheckDeps {
  readonly files: Files;
  readonly git: UpdateGit;
  readonly paths: UpdatePaths;
  now(): number;
}

const STATE_FILE = 'check.json';
const EMPTY: CheckState = { checkedAt: undefined, published: {}, dismissed: {} };

function textRecord(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function publishedRecord(value: unknown): Readonly<Record<string, Published>> {
  if (!isRecord(value)) {
    return {};
  }
  const entries: [string, Published][] = [];
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry) && typeof entry['sha'] === 'string') {
      entries.push([name, { sha: entry['sha'], versions: textRecord(entry['versions']) }]);
    }
  }
  return Object.fromEntries(entries);
}

/** The kept state; a missing file, or one of another shape, as nothing known. */
export function parseCheckState(text: string | undefined): CheckState {
  let value: unknown;
  try {
    value = text === undefined ? undefined : JSON.parse(text);
  } catch {
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
export function isNewer(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  return left !== undefined && right !== undefined && compareVersions(left, right) > 0;
}

/** The installs a newer version is published for, leaving out those the person dismissed that version or a newer one of. */
export function noticesOf(installs: readonly TrackedInstall[], state: CheckState): readonly UpdateNotice[] {
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
function folderName(marketplace: string): string {
  return marketplace.replace(/[^A-Za-z0-9._-]/g, '_');
}

export class UpdateCheck {
  private readonly deps: UpdateCheckDeps;

  constructor(deps: UpdateCheckDeps) {
    this.deps = deps;
  }

  private get stateFile(): string {
    return join(this.deps.paths.updatesFolder, STATE_FILE);
  }

  /**
   * The updates to tell of now. Asks the network first when the last check is CHECK_EVERY_MS old, or dated ahead of
   * the clock (the clock set back since), and only when a tracked plugin is installed.
   */
  async notices(): Promise<readonly UpdateNotice[]> {
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
  async dismiss(plugin: string, version: string): Promise<void> {
    const state = await this.state();
    await this.save({ ...state, dismissed: { ...state.dismissed, [plugin]: version } });
  }

  private async installs(): Promise<readonly TrackedInstall[]> {
    const text = await this.deps.files.read(join(this.deps.paths.pluginsFolder, INSTALLED_PLUGINS_FILE));
    return text === undefined ? [] : trackedInstallsOf(text);
  }

  private async state(): Promise<CheckState> {
    return parseCheckState(await this.deps.files.read(this.stateFile));
  }

  private async save(state: CheckState): Promise<void> {
    await this.deps.files.write(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async refresh(installs: readonly TrackedInstall[], before: CheckState, now: number): Promise<CheckState> {
    // The claim: a tab that looks while this one asks reads a fresh check and asks nothing.
    await this.save({ ...before, checkedAt: now });
    const known = (await this.deps.files.read(join(this.deps.paths.pluginsFolder, KNOWN_MARKETPLACES_FILE))) ?? '';
    const published: Record<string, Published> = { ...before.published };
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
    const after: CheckState = { checkedAt: now, published, dismissed: latest.dismissed };
    await this.save(after);
    return after;
  }

  private async publishedBy(marketplace: string, source: MarketplaceSource, plugins: readonly string[], before: Published | undefined): Promise<Published | undefined> {
    if (source.kind === 'directory') {
      const read = (path: string): Promise<string | undefined> => this.deps.files.read(join(source.path, path));
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
    const read = (path: string): Promise<string | undefined> => git.run(repo, ['show', `FETCH_HEAD:${path}`]);
    const found = await this.versionsIn(read, plugins, sha);
    await git.run(repo, ['gc', '--prune=now', '--quiet']);
    return found;
  }

  /** Makes the bare repository once, and points its `origin` at `url` with blobs fetched on demand. */
  private async ensureRepo(repo: string, url: string): Promise<boolean> {
    const { git, files } = this.deps;
    if ((await files.read(join(repo, 'HEAD'))) === undefined) {
      await files.makeFolder(repo);
      if ((await git.run(repo, ['init', '--bare', '--quiet'])) === undefined) {
        return false;
      }
    }
    for (const [key, value] of [['remote.origin.url', url], ['remote.origin.promisor', 'true'], ['remote.origin.partialclonefilter', 'blob:none']] as const) {
      if ((await git.run(repo, ['config', key, value])) === undefined) {
        return false;
      }
    }
    return true;
  }

  private async versionsIn(read: (path: string) => Promise<string | undefined>, plugins: readonly string[], sha: string): Promise<Published | undefined> {
    const marketplace = await read(MARKETPLACE_FILE);
    if (marketplace === undefined) {
      return undefined;
    }
    const versions: Record<string, string> = {};
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
