import { join } from 'node:path';
import { toJsonlLine } from "../core/jsonl.js";
import { SESSION_NAME } from "../register/model.js";
import { readMarks } from "./marks.js";
import { inboxLines } from "./unread.js";
const SUFFIX = '.md';
/** Inboxes as `<dir>/<area>.md`. Area names must be session ids, so none can escape the folder. */
export class InboxDir {
    files;
    dir;
    constructor(files, dir) {
        this.files = files;
        this.dir = dir;
    }
    async areas() {
        return (await this.files.list(this.dir))
            .filter((name) => name.endsWith(SUFFIX))
            .map((name) => name.slice(0, -SUFFIX.length))
            .filter((area) => SESSION_NAME.test(area))
            .sort();
    }
    async lines(area) {
        if (!SESSION_NAME.test(area)) {
            return undefined;
        }
        const text = await this.files.read(this.pathOf(area));
        return text === undefined ? undefined : inboxLines(text);
    }
    async append(area, line) {
        if (!SESSION_NAME.test(area)) {
            throw new Error(`${area} is not a session id`);
        }
        const path = this.pathOf(area);
        const current = await this.files.read(path);
        const separator = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
        await this.files.append(path, `${separator}${line}\n`);
    }
    pathOf(area) {
        return join(this.dir, `${area}${SUFFIX}`).replaceAll('\\', '/');
    }
}
export class JsonlMarkLog {
    files;
    path;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        return readMarks((await this.files.read(this.path)) ?? '');
    }
    async append(mark) {
        await this.files.append(this.path, toJsonlLine({ ...mark }));
    }
}
