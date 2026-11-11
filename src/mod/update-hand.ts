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

/** The CLI commands the hand runs, each `hook update-<command>`. */
export type UpdateCommand = 'check' | 'dismiss' | 'apply';

/** The command line that runs the plugin's CLI as `hook update-<command>`, given the plugin's folder. */
export function updateCliArgv(pluginRoot: string, command: UpdateCommand): readonly string[] {
  return ['node', `${pluginRoot}/dist/cli/main.js`, 'hook', `update-${command}`];
}

/** A newer version published than the one installed (src/update/check.ts UpdateNotice). */
export interface UpdateNotice {
  readonly plugin: string;
  readonly marketplace: string;
  readonly installed: string;
  readonly newest: string;
}

/** What the `hook update-*` commands answer (src/cli/commands/hook-update.ts UpdateAnswer). */
export type UpdateAnswer =
  | { readonly kind: 'notices'; readonly notices: readonly UpdateNotice[] }
  | { readonly kind: 'dismissed' }
  | { readonly kind: 'applied'; readonly plugin: string; readonly version: string }
  | { readonly kind: 'failed'; readonly why: string };

/** What a finished CLI run gave back. */
export interface UpdateRun {
  readonly exitCode: number;
  readonly stdout: string;
}

/** What the mod gives the hand: Claude Code's own calls, so the hand itself is plain code. */
export interface UpdateHandHost {
  /** Runs `hook update-<command>` with `stdin`; rejects when it cannot start. */
  cli(command: UpdateCommand, stdin: string): Promise<UpdateRun>;
  /** Shows the person a toast. */
  toast(text: string): void;
}

/** What one tick did. */
export type UpdateTick =
  /** A check, an update or a dismissal still runs. */
  | { readonly kind: 'overlap' }
  /** The CLI told of these updates (none: the tab runs the newest). */
  | { readonly kind: 'checked'; readonly notices: readonly UpdateNotice[] }
  | { readonly kind: 'failed'; readonly error: string };

/** What a press of the band's Update or Dismiss did. */
export type UpdateAction =
  /** No update is shown, or a check, an update or a dismissal still runs. */
  | { readonly kind: 'idle' }
  | { readonly kind: 'applied'; readonly plugin: string; readonly version: string }
  | { readonly kind: 'dismissed'; readonly plugin: string; readonly version: string }
  | { readonly kind: 'failed'; readonly error: string };

/** The band's line for an update. */
export function updateLine(notice: UpdateNotice): string {
  return `${notice.plugin} ${notice.newest} is out (you run ${notice.installed})`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function noticeOf(value: unknown): UpdateNotice | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { plugin, marketplace, installed, newest } = value;
  return typeof plugin === 'string' && typeof marketplace === 'string' && typeof installed === 'string' && typeof newest === 'string'
    ? { plugin, marketplace, installed, newest }
    : undefined;
}

function noticesOf(value: unknown): readonly UpdateNotice[] | undefined {
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
export function parseUpdateAnswer(stdout: string): UpdateAnswer | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UpdateHand {
  private readonly host: UpdateHandHost;
  private notices: readonly UpdateNotice[] = [];
  private busy = false;

  constructor(host: UpdateHandHost) {
    this.host = host;
  }

  /** The update the band shows: the first the CLI told of and the person has not updated or dismissed. */
  notice(): UpdateNotice | undefined {
    return this.notices[0];
  }

  /** One check; never rejects. A failed one keeps the updates shown, and the next tick asks again. */
  async tick(): Promise<UpdateTick> {
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
    } catch (error) {
      return { kind: 'failed', error: messageOf(error) };
    } finally {
      this.busy = false;
    }
  }

  /** The band's Update: installs the shown update and tells the person how it went; never rejects. */
  async apply(): Promise<UpdateAction> {
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
  async dismiss(): Promise<UpdateAction> {
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
  private async act(press: (notice: UpdateNotice) => Promise<UpdateAction>, what: string): Promise<UpdateAction> {
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
    } catch (error) {
      const failed: UpdateAction = { kind: 'failed', error: messageOf(error) };
      this.host.toast(`${notice.plugin} ${what} failed: ${failed.error}`);
      return failed;
    } finally {
      this.busy = false;
    }
  }

  private drop(plugin: string): void {
    this.notices = this.notices.filter((each) => each.plugin !== plugin);
  }

  private async ask(command: UpdateCommand, request: Readonly<Record<string, string>>): Promise<UpdateAnswer> {
    const run = await this.host.cli(command, JSON.stringify(request));
    const answer = run.exitCode === 0 ? parseUpdateAnswer(run.stdout) : undefined;
    if (answer === undefined) {
      throw new Error(`hook update-${command} exited ${run.exitCode}: ${run.stdout.trim().slice(0, 200)}`);
    }
    return answer;
  }
}
