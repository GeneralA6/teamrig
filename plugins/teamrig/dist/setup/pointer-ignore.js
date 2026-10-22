import { TEAM_POINTER } from "../core/team.js";
/** The exclude line: every team pointer in the repository, at any depth. */
export const POINTER_EXCLUDE_LINE = TEAM_POINTER;
export function ignoreStep(git, pointer) {
    const state = git.state(pointer);
    switch (state.kind) {
        case 'no-git':
            return { kind: 'none' };
        case 'tracked':
            return { kind: 'keep', pointer, why: `it is committed, so every clone gets it; to keep it on this machine only, run git rm --cached ${TEAM_POINTER} and commit` };
        case 'ignored':
            return { kind: 'keep', pointer, why: 'git already ignores it' };
        case 'open':
            return { kind: 'add', pointer, exclude: state.exclude };
    }
}
/** Appends the exclude line, on a line of its own after any text the file ends without a newline. */
export async function applyIgnore(files, step) {
    if (step.kind !== 'add') {
        return;
    }
    const text = (await files.read(step.exclude)) ?? '';
    const gap = text === '' || text.endsWith('\n') ? '' : '\n';
    await files.append(step.exclude, `${gap}${POINTER_EXCLUDE_LINE}\n`);
}
/** The summary line of an ignore step, or none outside git. */
export function ignoreLines(step, dryRun) {
    switch (step.kind) {
        case 'none':
            return [];
        case 'keep':
            return [`UNCHANGED ${step.pointer} in git: ${step.why}`];
        case 'add':
            return [`${dryRun ? 'WOULD ADD' : 'ADDED'} ${POINTER_EXCLUDE_LINE} to ${step.exclude}: git ignores it in this clone only, as the team it names exists on this machine only`];
    }
}
