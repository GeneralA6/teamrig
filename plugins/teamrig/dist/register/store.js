import { toJsonlLine } from "../core/jsonl.js";
import { eventRecord } from "./events.js";
import { RETAIN_DAYS } from "./compaction.js";
import { layoutPaths, readHistory, readWorkingSet } from "./layout.js";
import { applyRotation, AUTO_ROTATE_CHARS, planRotation } from "./rotate.js";
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
    async append(events) {
        await this.files.append(this.path, events.map((event) => toJsonlLine(eventRecord(event))).join(''));
    }
    async rotateIfDue(written, now) {
        if (written.read.rotatedAfter === 0) {
            return null;
        }
        const tailText = (await this.files.read(this.path)) ?? '';
        if (tailText.length < AUTO_ROTATE_CHARS) {
            return null;
        }
        const plan = await planRotation(this.files, this.layout, { now, retainDays: RETAIN_DAYS, keep: new Set(), checkHistory: false }, tailText);
        await applyRotation(this.files, this.layout, plan);
        return plan;
    }
}
