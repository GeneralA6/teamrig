import { toJsonlLine } from "../core/jsonl.js";
import { readEvents } from "./snapshot.js";
export class JsonlEventLog {
    path;
    files;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        return readEvents((await this.files.read(this.path)) ?? '');
    }
    async append(event) {
        await this.files.append(this.path, toJsonlLine({ ...event }));
    }
}
