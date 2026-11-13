import { join } from 'node:path';
import { writableObject } from "../core/jsonl.js";
import { formatCarriedJobs, parseCarriedJobs } from "./carry.js";
import { formatParkedRestart, formatRefreshRequest, formatRefreshState, formatRestartRequest, parseParkedRestart, parseRefreshRequest, parseRefreshState, parseRestartRequest, REFRESH_STATE_FORMAT, } from "./state.js";
/**
 * Each session's refresh files. The state (`<id>.json`) is written only by the session itself, from
 * its commands and hooks; the lead's request (`<id>.request.json`) is a file of its own, so neither
 * write ever overwrites the other's; so is the automatic restart (`<id>.restart.json`), which the
 * session's hooks, its restart and `teamrig launch` share, and the restart held back until work comes
 * (`<id>.parked.json`), which its Stop hook writes and its wake check arms. The jobs a /clear left live in the session's process
 * (`<id>.carried.json`) are written by its SessionStart hook. Ids are session ids, checked by the roster, so they
 * are safe in a path.
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
    /** Throws NewerDataError when a newer teamrig wrote the file: an older one never overwrites what it cannot read. */
    async setState(id, state) {
        const path = this.statePath(id);
        writableObject(path, await this.files.read(path), REFRESH_STATE_FORMAT);
        await this.files.write(path, formatRefreshState(state));
    }
    async request(id) {
        const text = await this.files.read(this.requestPath(id));
        return text === undefined ? undefined : parseRefreshRequest(text);
    }
    setRequest(id, request) {
        return this.files.write(this.requestPath(id), formatRefreshRequest(request));
    }
    async clearRequest(id) {
        await this.files.remove(this.requestPath(id));
    }
    async restart(id) {
        const text = await this.files.read(this.restartPath(id));
        return text === undefined ? undefined : parseRestartRequest(text);
    }
    setRestart(id, request) {
        return this.files.write(this.restartPath(id), formatRestartRequest(request));
    }
    async clearRestart(id) {
        await this.files.remove(this.restartPath(id));
    }
    /** The restart held back until work comes; undefined when none, or the file is damaged. */
    async parked(id) {
        const text = await this.files.read(this.parkedPath(id));
        return text === undefined ? undefined : parseParkedRestart(text);
    }
    setParked(id, parked) {
        return this.files.write(this.parkedPath(id), formatParkedRestart(parked));
    }
    async clearParked(id) {
        await this.files.remove(this.parkedPath(id));
    }
    /** The jobs the last /clear left live in the session's process; undefined when none, or the file is damaged. */
    async carried(id) {
        const text = await this.files.read(this.carriedPath(id));
        return text === undefined ? undefined : parseCarriedJobs(text);
    }
    setCarried(id, jobs) {
        return this.files.write(this.carriedPath(id), formatCarriedJobs(jobs));
    }
    async clearCarried(id) {
        await this.files.remove(this.carriedPath(id));
    }
    statePath(id) {
        return join(this.paths.refresh, `${id}.json`);
    }
    requestPath(id) {
        return join(this.paths.refresh, `${id}.request.json`);
    }
    restartPath(id) {
        return join(this.paths.refresh, `${id}.restart.json`);
    }
    parkedPath(id) {
        return join(this.paths.refresh, `${id}.parked.json`);
    }
    carriedPath(id) {
        return join(this.paths.refresh, `${id}.carried.json`);
    }
}
