import { join } from 'node:path';
/**
 * Every automatic restart's outcome, one JSON line each in the team's `refresh/restarts.jsonl`. The restart
 * runs hidden and only a failure reaches the session's inbox, so this is what a trial or a live week of
 * refreshes is judged on (stuck, duplicate or lost sessions). About 9 lines a day for 12 sessions.
 */
export class RestartLog {
    files;
    path;
    constructor(files, paths) {
        this.files = files;
        this.path = join(paths.refresh, 'restarts.jsonl');
    }
    record(entry) {
        return this.files.append(this.path, `${JSON.stringify(entry)}\n`);
    }
}
