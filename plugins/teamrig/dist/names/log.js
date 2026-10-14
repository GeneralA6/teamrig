import { parseJsonl, toJsonlLine } from "../core/jsonl.js";
import { parseRename } from "./rename.js";
export class JsonlRenameLog {
    path;
    files;
    constructor(files, path) {
        this.files = files;
        this.path = path;
    }
    async read() {
        const parse = parseJsonl((await this.files.read(this.path)) ?? '');
        const renames = [];
        let unreadable = parse.unreadable;
        let newer = 0;
        for (const line of parse.records) {
            const result = parseRename(line);
            if (result.kind === 'rename') {
                renames.push(result.rename);
            }
            else if (result.kind === 'newer') {
                newer += 1;
            }
            else {
                unreadable += 1;
            }
        }
        return { renames, unreadable, newer };
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
