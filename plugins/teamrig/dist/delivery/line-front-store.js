import { join } from 'node:path';
import { isLineFront, LINE_FRONT_FILE } from "./line-front.js";
/** The path of the front file in the team's state folder `state`. */
export function lineFrontPath(state) {
    return join(state, LINE_FRONT_FILE);
}
/**
 * The team's front file (T4082). A file that does not parse (one being replaced, a hand edit) reads as no front: a
 * front only moves a step ahead, so reading none at worst leaves the line in its usual order.
 */
export class LineFrontStore {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const text = await this.files.read(this.path);
        if (text === undefined) {
            return undefined;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            return undefined;
        }
        return isLineFront(parsed) ? parsed : undefined;
    }
    /** Puts `front` at the front, replacing the one there. */
    async put(front) {
        await this.files.write(this.path, `${JSON.stringify(front)}\n`);
    }
    /** Takes the front off: true when one was there. */
    async clear() {
        return this.files.remove(this.path);
    }
}
