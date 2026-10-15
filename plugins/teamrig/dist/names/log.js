import { toJsonlLine } from "../core/jsonl.js";
import { readRenames } from "./rename.js";
export class JsonlRenameLog {
    path;
    files;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        return readRenames((await this.files.read(this.path)) ?? '');
    }
    /**
     * One whole line in one append, so a crash never leaves half a record. A last line written by
     * hand without its newline gets one first, so the two records never run together.
     */
    async append(rename) {
        const current = await this.files.read(this.path);
        const separator = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
        await this.files.append(this.path, `${separator}${toJsonlLine({ ...rename })}`);
    }
}
