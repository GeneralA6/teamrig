import { join } from 'node:path';
import { formatRefreshRequest, formatRefreshState, parseRefreshRequest, parseRefreshState } from "./state.js";
/**
 * Each session's refresh files. The state (`<id>.json`) is written only by the session itself, from
 * its commands and hooks; the lead's request (`<id>.request.json`) is a file of its own, so neither
 * write ever overwrites the other's. Ids are session ids, checked by the roster, so they are safe in a path.
 */
export class RefreshStore {
    files;
    paths;
    constructor(files, paths) {
        this.files = files;
        this.paths = paths;
    }
    /** Where the session writes its handover before a refresh. */
    handoverPath(id) {
        return join(this.paths.handover, `${id}.md`);
    }
    /** The handover's text; undefined when the session has not written one. */
    handover(id) {
        return this.files.read(this.handoverPath(id));
    }
    /** The session's state; undefined when it has none, or the file is damaged or from another format. */
    async state(id) {
        const text = await this.files.read(this.statePath(id));
        return text === undefined ? undefined : parseRefreshState(text);
    }
    setState(id, state) {
        return this.files.write(this.statePath(id), formatRefreshState(state));
    }
    async request(id) {
        const text = await this.files.read(this.requestPath(id));
        return text === undefined ? undefined : parseRefreshRequest(text);
    }
    setRequest(id, request) {
        return this.files.write(this.requestPath(id), formatRefreshRequest(request));
    }
    clearRequest(id) {
        return this.files.remove(this.requestPath(id));
    }
    statePath(id) {
        return join(this.paths.refresh, `${id}.json`);
    }
    requestPath(id) {
        return join(this.paths.refresh, `${id}.request.json`);
    }
}
