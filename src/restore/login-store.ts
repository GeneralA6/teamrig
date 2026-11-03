import type { Files } from '../core/files.ts';
import type { Mutex } from '../core/lock.ts';
import { applyLoginEvent, claimPage, decideLoginRetry, formatLoginMarker, parseLoginMarker, releasePage, type LoginChange, type LoginEvent, type LoginMarker, type LoginRetry } from './login.ts';

/** What `apply` did: the change it wrote (its marker as written), and whether this event claimed the owner's page. */
export interface LoginApplied {
  readonly change: LoginChange;
  readonly pageClaimed: boolean;
}

/** How `apply` treats the owner's page: `claimPage` claims it for an expiry no tab has paged yet. */
export interface LoginApplyOptions {
  readonly claimPage?: boolean;
}

/**
 * The login marker's file (src/restore/login.ts). Every turn end of every tab reads it, so a read takes no lock;
 * only an event that changes it takes the lock, then reads it again and writes, since a dozen tabs fail at once. The
 * page claim sits in the same locked write, so of a dozen failures one pages.
 */
export class LoginStore {
  private readonly files: Files;
  private readonly path: string;
  private readonly lock: Mutex;

  constructor(files: Files, path: string, lock: Mutex) {
    this.files = files;
    this.path = path;
    this.lock = lock;
  }

  /** The marker; undefined when there is none, or a damaged one. */
  async read(): Promise<LoginMarker | undefined> {
    const text = await this.files.read(this.path);
    return text === undefined ? undefined : parseLoginMarker(text);
  }

  /** Applies `event`, writing the marker when it changes; the change as the locked read saw it. */
  async apply(event: LoginEvent, { claimPage: claim = false }: LoginApplyOptions = {}): Promise<LoginApplied> {
    if (applyLoginEvent(await this.read(), event).kind === 'none') {
      return { change: { kind: 'none' }, pageClaimed: false };
    }
    return this.lock.run(async () => {
      const change = applyLoginEvent(await this.read(), event);
      if (change.kind === 'none') {
        return { change, pageClaimed: false };
      }
      const claimed = claim ? claimPage(change.marker, event.at) : undefined;
      const marker = claimed ?? change.marker;
      await this.files.write(this.path, formatLoginMarker(marker));
      return { change: { ...change, marker }, pageClaimed: claimed !== undefined };
    });
  }

  /**
   * Claims a stuck tab's retry (`decideLoginRetry`) when one is due, writing the claim; what it decided. Each idle
   * tab's wake check asks, so only a retry due without the lock takes it, then decides again on the locked read: of
   * two tabs due at once, one claims and the other sees its claim.
   */
  async claimRetry(tab: string, now: number, credentialsAt: number | undefined): Promise<LoginRetry> {
    const unlocked = decideLoginRetry(await this.read(), tab, now, credentialsAt);
    if (unlocked.kind !== 'retry') {
      return unlocked;
    }
    return this.lock.run(async () => {
      const retry = decideLoginRetry(await this.read(), tab, now, credentialsAt);
      if (retry.kind === 'retry') {
        await this.files.write(this.path, formatLoginMarker(retry.marker));
      }
      return retry;
    });
  }

  /** Gives back the page claimed at `claimedAt` after its post failed; false when the marker holds another claim now. */
  async releasePage(claimedAt: number): Promise<boolean> {
    return this.lock.run(async () => {
      const existing = await this.read();
      const released = existing === undefined ? undefined : releasePage(existing, claimedAt);
      if (released === undefined) {
        return false;
      }
      await this.files.write(this.path, formatLoginMarker(released));
      return true;
    });
  }
}
