import { toJsonlLine } from "../core/jsonl.js";
import { layoutPaths, readHistory, readWorkingSet } from "./layout.js";
export class JsonlEventLog {
    path;
    files;
    layout;
    constructor(files, path) {
        this.files = files;
        this.path = path;
        this.layout = layoutPaths(path);
    }
    read() {
        return readWorkingSet(this.files, this.layout);
    }
    readHistory() {
        return readHistory(this.files, this.layout);
    }
    async append(event) {
        await this.files.append(this.path, toJsonlLine({ ...event }));
    }
}
