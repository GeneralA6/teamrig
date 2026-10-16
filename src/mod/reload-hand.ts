/**
 * The tab's side of a plugin update. `claude plugin update` installs a new version into Claude Code's plugin cache
 * and records it in `installed_plugins.json`, but an open tab runs what it loaded until `/reload-plugins` ("activate
 * pending plugin changes in the current session"). The plugin's mod (`hooks/register.ts`) runs a `ReloadHand` in
 * every interactive tab. When the mod loads, the hand takes the fingerprint of the installs that apply to the tab;
 * it reads the file again every CHECK_MS, and once an install changed (teamrig's, the pane's or any other plugin's),
 * the file has read the same for SETTLE_MS and no turn runs, it runs /reload-plugins the way the person would. It
 * runs at most one reload per RELOAD_GAP_MS, waits as long after a refused one, and never runs two for the same
 * installs.
 *
 * The mod runs inside Claude Code without Node, so this file imports nothing at run time: it compiles to a module
 * the mod imports as it is.
 */

/** How often the hand reads installed_plugins.json. */
export const CHECK_MS = 15_000;
/** How long the file must read the same before a reload, so updating several plugins in a row is one reload. */
export const SETTLE_MS = 10_000;
/** The least time between two reloads in one tab, and the wait after a refused one. */
export const RELOAD_GAP_MS = 5 * 60_000;
/** The command the hand runs: Claude Code's own `/reload-plugins`. */
export const RELOAD_COMMAND = 'reload-plugins';
/** Where Claude Code records its installed plugins: in the `plugins` folder that holds the `cache` of installs. */
export const INSTALLED_PLUGINS_FILE = 'installed_plugins.json';

/** What the hand keeps in the session about its last reload, so the mod a reload loads still keeps the gap. */
export interface ReloadRecord {
  /** The installs it reloaded for (installedFingerprint). */
  readonly fingerprint: string;
  /** When it ran the reload, in milliseconds since the epoch. */
  readonly at: number;
}

/** What the mod gives the hand: Claude Code's own calls, so the hand itself is plain code. */
export interface ReloadHandHost {
  /** The text of installed_plugins.json; rejects when it is missing or unreadable. */
  readInstalled(): Promise<string>;
  /** The session's project root now, which project- and local-scope installs are for. */
  projectRoot(): Promise<string>;
  /** Runs /reload-plugins in the tab as if the person typed it, resolving to what it printed. */
  reload(): Promise<string>;
  /** What the session keeps of the last reload, read when the mod loads; anything but a ReloadRecord is none. */
  recall(): Promise<unknown>;
  /** Keeps the record in the session, where the mod a reload loads finds it. */
  remember(record: ReloadRecord): Promise<void>;
  now(): number;
}

/** What one check did. */
export type CheckResult =
  /** installed_plugins.json is missing, unreadable or of another shape: no change seen. */
  | { readonly kind: 'no file' }
  /** The installs that apply to this tab are the ones it runs. */
  | { readonly kind: 'no change' }
  /** The installs are ones the hand already reloaded for. */
  | { readonly kind: 'reloaded before' }
  /** An install changed, and the file has not read the same for SETTLE_MS yet. */
  | { readonly kind: 'settling' }
  /** A turn runs, so the reload waits for it to end. */
  | { readonly kind: 'busy' }
  /** The last reload, or a refused one, was less than RELOAD_GAP_MS ago: the next waits until `until`. */
  | { readonly kind: 'held'; readonly until: number }
  /** /reload-plugins ran and printed `text`; `kept` says whether the session kept its record. */
  | { readonly kind: 'reloaded'; readonly text: string; readonly kept: boolean }
  /** Claude Code refused /reload-plugins; the hand tries again RELOAD_GAP_MS later. */
  | { readonly kind: 'refused'; readonly error: string }
  /** The check before still runs (a reload waits for the session to be idle). */
  | { readonly kind: 'overlap' }
  | { readonly kind: 'failed'; readonly error: string };

/** One install as installed_plugins.json (version 2) records it, in the list under its `<plugin>@<marketplace>`. */
interface Install {
  /** `user`, or `project` / `local` for the project at `projectPath`. */
  readonly scope: string;
  readonly installPath: string;
  readonly version: string;
  readonly gitCommitSha: string;
  readonly projectPath: string | undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isReloadRecord(value: unknown): value is ReloadRecord {
  return (
    isRecord(value) && typeof value['fingerprint'] === 'string' && typeof value['at'] === 'number' && Number.isFinite(value['at'])
  );
}

function parsed(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function installOf(entry: unknown): Install | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const scope = entry['scope'];
  const installPath = entry['installPath'];
  const version = entry['version'];
  const gitCommitSha = entry['gitCommitSha'];
  const projectPath = entry['projectPath'];
  if (typeof scope !== 'string' || typeof installPath !== 'string') {
    return undefined;
  }
  if (!isOptionalText(version) || !isOptionalText(gitCommitSha) || !isOptionalText(projectPath)) {
    return undefined;
  }
  return { scope, installPath, version: version ?? '', gitCommitSha: gitCommitSha ?? '', projectPath };
}

/** A path with a drive letter or a UNC start: Windows, where case and the slash's direction do not matter. */
const WINDOWS_PATH = /^(?:[A-Za-z]:|[\\/]{2})/;

function withoutTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') {
    end -= 1;
  }
  return path.slice(0, end);
}

/** Whether two spellings name one folder; on Windows `\` and `/` are one separator and case does not matter. */
export function samePath(a: string, b: string): boolean {
  if (WINDOWS_PATH.test(a) || WINDOWS_PATH.test(b)) {
    const windows = (path: string): string => withoutTrailingSlash(path.replaceAll('\\', '/')).toLowerCase();
    return windows(a) === windows(b);
  }
  return withoutTrailingSlash(a) === withoutTrailingSlash(b);
}

function appliesTo(install: Install, projectRoot: string): boolean {
  if (install.scope === 'user') {
    return true;
  }
  const forAProject = install.scope === 'project' || install.scope === 'local';
  return forAProject && install.projectPath !== undefined && samePath(install.projectPath, projectRoot);
}

/**
 * The installs that apply to a tab whose project root is `projectRoot`: every user-scope install and the project- and
 * local-scope ones for that project, each as its plugin, folder, version and commit, sorted. Undefined for a text
 * that is not installed_plugins.json's shape, so a file mid-write or of another version reads as no change.
 */
export function installedFingerprint(text: string, projectRoot: string): string | undefined {
  const file = parsed(text);
  if (!isRecord(file)) {
    return undefined;
  }
  const plugins = file['plugins'];
  if (!isRecord(plugins)) {
    return undefined;
  }
  const lines: string[] = [];
  for (const [key, entries] of Object.entries(plugins)) {
    if (!isList(entries)) {
      return undefined;
    }
    for (const entry of entries) {
      const install = installOf(entry);
      if (install === undefined) {
        return undefined;
      }
      if (appliesTo(install, projectRoot)) {
        lines.push(JSON.stringify([key, install.installPath, install.version, install.gitCommitSha]));
      }
    }
  }
  return lines.sort().join('\n');
}

/**
 * installed_plugins.json for a plugin Claude Code runs from its cache
 * (`<config>/plugins/cache/<marketplace>/<plugin>/<version>`): the file sits in that `plugins` folder, so the path follows the configuration folder this Claude Code really uses
 * (`CLAUDE_CONFIG_DIR` too) with no environment read. Undefined for a plugin run from anywhere else (`--plugin-dir`,
 * a marketplace that is a local folder).
 */
export function installedPluginsFileOf(pluginRoot: string): string | undefined {
  const parts = pluginRoot.split(/[\\/]/);
  while (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
  }
  const count = parts.length;
  if (count < 6 || parts[count - 5] !== 'plugins' || parts[count - 4] !== 'cache') {
    return undefined;
  }
  return [...parts.slice(0, count - 4), INSTALLED_PLUGINS_FILE].join('/');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ReloadHand {
  private readonly host: ReloadHandHost;
  /** The installs this tab runs: taken when the mod loads (or at the first file it can read), and after each reload. */
  private loaded: string | undefined;
  /** The file's text at the last read, and since when it has read so. */
  private lastText: string | undefined;
  private sameSince = 0;
  /** The installs the hand ran a reload for, so it never runs a second one for them. */
  private readonly reloadedFor = new Set<string>();
  /** When the last reload started, or was refused: the next waits RELOAD_GAP_MS from then. */
  private heldFrom: number | undefined;
  /** The turns running now, the main loop's and subagents' alike, by turn id. */
  private readonly turns = new Set<string>();
  private checking = false;

  constructor(host: ReloadHandHost) {
    this.host = host;
  }

  turnStarted(turnId: string): void {
    this.turns.add(turnId);
  }

  turnEnded(turnId: string): void {
    this.turns.delete(turnId);
  }

  /** Takes what the tab loaded and the last reload the session kept; never rejects. */
  async start(): Promise<void> {
    const record = await this.host.recall().catch(() => undefined);
    if (isReloadRecord(record)) {
      this.reloadedFor.add(record.fingerprint);
      this.heldFrom = record.at;
    }
    this.loaded = await this.look(this.host.now()).catch(() => undefined);
  }

  async check(): Promise<CheckResult> {
    if (this.checking) {
      return { kind: 'overlap' };
    }
    this.checking = true;
    try {
      return await this.step();
    } catch (error) {
      return { kind: 'failed', error: messageOf(error) };
    } finally {
      this.checking = false;
    }
  }

  private async step(): Promise<CheckResult> {
    const now = this.host.now();
    const fingerprint = await this.look(now);
    if (fingerprint === undefined) {
      return { kind: 'no file' };
    }
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
    return this.reloadFor(fingerprint, now);
  }

  /**
   * Records the reload before running it, in the hand and in the session, so neither this hand nor the mod the
   * reload loads runs it again. A reload that leaves this module loaded keeps the hand, which then takes the file
   * as it reads now as loaded; a refused one waits RELOAD_GAP_MS and may run again.
   */
  private async reloadFor(fingerprint: string, now: number): Promise<CheckResult> {
    this.reloadedFor.add(fingerprint);
    this.heldFrom = now;
    const kept = await this.host.remember({ fingerprint, at: now }).then(
      () => true,
      () => false,
    );
    let text: string;
    try {
      text = await this.host.reload();
    } catch (error) {
      this.reloadedFor.delete(fingerprint);
      this.heldFrom = this.host.now();
      return { kind: 'refused', error: messageOf(error) };
    }
    this.loaded = (await this.look(this.host.now()).catch(() => undefined)) ?? fingerprint;
    return { kind: 'reloaded', text, kept };
  }

  /** Reads the file, notes since when its text has stood, and returns the fingerprint of the installs for this tab. */
  private async look(now: number): Promise<string | undefined> {
    let text: string;
    try {
      text = await this.host.readInstalled();
    } catch {
      return undefined;
    }
    if (text !== this.lastText) {
      this.lastText = text;
      this.sameSince = now;
    }
    return installedFingerprint(text, await this.host.projectRoot());
  }
}
