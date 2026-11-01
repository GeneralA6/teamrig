import { assertWritable, parseJsonl, toJsonlLine } from "../core/jsonl.js";
import { foldGoalLines, GOAL_RECORD_VERSION, goalAddRefusal, goalRecordJson, goalSetRefusal, readGoals, } from "./goals.js";
/**
 * A team's goal records file (T1730): reads fold it, writes append one record under the lock after re-reading it, so
 * two leads' writes never both pass a check that only one of them can (two adds of one tag). A file holding records
 * of a newer teamrig is refused for writes (NewerDataError), never mixed with this version's.
 */
export class GoalStore {
    files;
    path;
    mutex;
    constructor(files, path, mutex) {
        this.files = files;
        this.path = path;
        this.mutex = mutex;
    }
    /** The goals as recorded; none when the file does not exist yet. */
    async read() {
        return readGoals(await this.files.read(this.path));
    }
    /** Adds a goal, unless goalAddRefusal refuses it over the records as they stand under the lock. */
    async add(input, writer) {
        return this.mutex.run(async () => {
            const reason = goalAddRefusal(input, (await this.writable()).goals);
            if (reason !== undefined) {
                return { kind: 'refused', reason };
            }
            const record = { type: 'goal-add', ...writer, tag: input.tag, title: input.title, start: input.start, target: input.target, parent: input.parent };
            return this.append(record);
        });
    }
    /** Moves a goal's target or renames it, with the note saying why, unless goalSetRefusal refuses it. */
    async set(input, writer) {
        return this.mutex.run(async () => {
            const reason = goalSetRefusal(input, (await this.writable()).goals);
            if (reason !== undefined) {
                return { kind: 'refused', reason };
            }
            const record = { type: 'goal-set', ...writer, tag: input.tag, target: input.target, title: input.title, note: input.note };
            return this.append(record);
        });
    }
    /** The records as they stand, refused when a newer teamrig wrote some. */
    async writable() {
        const parsed = parseJsonl((await this.files.read(this.path)) ?? '');
        assertWritable(this.path, parsed, GOAL_RECORD_VERSION);
        return foldGoalLines(parsed);
    }
    async append(record) {
        await this.files.append(this.path, toJsonlLine(goalRecordJson(record)));
        return { kind: 'written', record };
    }
}
