import { applyLoginEvent, claimPage, formatLoginMarker, parseLoginMarker, releasePage } from "./login.js";
/**
 * The login marker's file (src/restore/login.ts). Every turn end of every tab reads it, so a read takes no lock;
 * only an event that changes it takes the lock, then reads it again and writes, since a dozen tabs fail at once. The
 * page claim sits in the same locked write, so of a dozen failures one pages.
 */
export class LoginStore {
    files;
    path;
    lock;
    constructor(files, path, lock) {
        this.files = files;
        this.path = path;
        this.lock = lock;
    }
    /** The marker; undefined when there is none, or a damaged one. */
    async read() {
        const text = await this.files.read(this.path);
        return text === undefined ? undefined : parseLoginMarker(text);
    }
    /** Applies `event`, writing the marker when it changes; the change as the locked read saw it. */
    async apply(event, { claimPage: claim = false } = {}) {
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
    /** Gives back the page claimed at `claimedAt` after its post failed; false when the marker holds another claim now. */
    async releasePage(claimedAt) {
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
