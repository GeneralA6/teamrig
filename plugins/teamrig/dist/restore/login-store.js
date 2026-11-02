import { applyLoginEvent, formatLoginMarker, parseLoginMarker } from "./login.js";
/**
 * The login marker's file (src/restore/login.ts). Every turn end of every tab reads it, so a read takes no lock;
 * only an event that changes it takes the lock, then reads it again and writes, since a dozen tabs fail at once.
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
    async apply(event) {
        if (applyLoginEvent(await this.read(), event).kind === 'none') {
            return { kind: 'none' };
        }
        return this.lock.run(async () => {
            const change = applyLoginEvent(await this.read(), event);
            if (change.kind === 'write') {
                await this.files.write(this.path, formatLoginMarker(change.marker));
            }
            return change;
        });
    }
}
