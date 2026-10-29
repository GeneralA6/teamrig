import { join, resolve } from 'node:path';
import { isRecord } from "../core/guards.js";
/** The folder in the git common dir that holds the pass records. */
export const PASS_RECORD_FOLDER = 'local-ci';
/** Where the pass record of a tree lives; `gitCommonDir` as `git rev-parse --git-common-dir` prints it, relative to `root` or absolute. */
export function passRecordPath(root, gitCommonDir, tree) {
    return join(resolve(root, gitCommonDir), PASS_RECORD_FOLDER, `${tree}.json`);
}
const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
/** The record in a file's text, or undefined when there is none, it does not parse, or it proves another tree. */
export function parsePassRecord(text, tree) {
    if (text === undefined)
        return undefined;
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value))
        return undefined;
    const { commit, checks, passedAt, node } = value;
    if (value['tree'] !== tree || typeof commit !== 'string' || !isStringList(checks) || typeof passedAt !== 'string' || typeof node !== 'string')
        return undefined;
    return { tree, commit, checks, passedAt, node };
}
