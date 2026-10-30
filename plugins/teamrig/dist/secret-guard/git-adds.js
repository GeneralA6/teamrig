/**
 * How git prints the patches these parsers read: no context, no colour, no external diff or textconv (a textconv could
 * print a file's content other than it is stored), no `a/`/`b/` prefix, every path from the repo's top folder (a
 * `diff.relative` config would hide the changes outside the folder git runs in) and renames found. No `--diff-filter`:
 * in a log it drops whole commits (a merge, a commit that only deletes), and their messages with them; a deleted file
 * adds nothing here. Run with `-c core.quotePath=false`, so a non-ASCII name is printed as itself.
 */
export const PATCH_FLAGS = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-prefix', '--no-relative', '-M'];
/** The `git log` format `commitsOf` splits: NUL, id, NUL, message, NUL, then the commit's patch. A message holds no NUL. */
export const COMMIT_FORMAT = '--format=%x00%H%x00%B%x00';
/**
 * The line `git commit --verbose` puts above the diff it appends to the message: a comment string (`#` by default; any
 * here, as `core.commentChar` is not read), a space and the cut mark, alone on its line, as git finds it to cut there.
 */
const SCISSORS = /^\S+ -{24} >8 -{24}$/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
/**
 * A path as git prints it: as is, or C-quoted (`"a\tb"`, a byte as `\ooo`) when it holds a control character, a quote
 * or a backslash. A quoted path's bytes are read as UTF-8.
 */
export function gitPath(text) {
    if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) {
        return text;
    }
    const bytes = [];
    for (const [token, octal, escaped] of text.slice(1, -1).matchAll(/\\([0-7]{3})|\\(.)|[^\\]+/gsu)) {
        if (octal !== undefined) {
            bytes.push(Buffer.of(Number.parseInt(octal, 8)));
        }
        else if (escaped !== undefined) {
            bytes.push(Buffer.of(ESCAPES[escaped] ?? escaped.charCodeAt(0)));
        }
        else {
            bytes.push(Buffer.from(token, 'utf8'));
        }
    }
    return Buffer.concat(bytes).toString('utf8');
}
/** The path of a `---`/`+++` line: git adds a tab after a name that holds a space. */
function sidePath(text) {
    return gitPath(text.endsWith('\t') ? text.slice(0, -1) : text);
}
/** The path of `diff --git <old> <new>` when both sides are the same path; a move names its new path on `rename to`. */
function samePath(sides) {
    const half = (sides.length - 1) / 2;
    const old = sides.slice(0, half);
    return Number.isInteger(half) && sides === `${old} ${old}` ? gitPath(old) : undefined;
}
const FILE_START = 'diff --git ';
/** Each file's new path and the lines a patch printed with `PATCH_FLAGS` adds, in order. */
export function patchAdds(patch) {
    const paths = [];
    const lines = [];
    let header;
    let file;
    let oldLeft = 0;
    let newLeft = 0;
    let next = 0;
    const close = () => {
        if (header !== undefined && !header.deleted && header.path !== undefined) {
            paths.push(header.path);
        }
    };
    for (const text of patch.split('\n')) {
        if (oldLeft > 0 || newLeft > 0) {
            // A hunk's body: its counts say which lines are its own, so an added line `+++ x` is never read as a header.
            if (text.startsWith('+')) {
                newLeft -= 1;
                if (file !== undefined) {
                    lines.push({ file, line: next, text: text.slice(1) });
                }
                next += 1;
            }
            else if (text.startsWith('-')) {
                oldLeft -= 1;
            }
            else if (!text.startsWith('\\')) {
                oldLeft -= 1;
                newLeft -= 1;
                next += 1;
            }
            continue;
        }
        if (text.startsWith(FILE_START)) {
            close();
            header = { path: samePath(text.slice(FILE_START.length)), deleted: false };
            file = undefined;
            continue;
        }
        const hunk = HUNK.exec(text);
        if (hunk !== null) {
            oldLeft = Number(hunk[1] ?? '1');
            next = Number(hunk[2]);
            newLeft = Number(hunk[3] ?? '1');
            continue;
        }
        if (header === undefined) {
            continue;
        }
        if (text.startsWith('deleted file mode')) {
            header.deleted = true;
        }
        else if (text.startsWith('rename to ') || text.startsWith('copy to ')) {
            header.path = gitPath(text.slice(text.indexOf(' to ') + 4));
        }
        else if (text.startsWith('+++ ') && text !== '+++ /dev/null') {
            file = sidePath(text.slice(4));
            header.path = file;
        }
    }
    close();
    return { paths, lines };
}
/**
 * The commits of a `git log -p` printed with `COMMIT_FORMAT` and `PATCH_FLAGS`, newest first as git prints them. A log
 * cut short keeps its last commit with what it holds, so a cut never hides a line from the scan.
 */
export function commitsOf(log) {
    const fields = log.split('\0').slice(1);
    const commits = [];
    for (const [at, sha] of fields.entries()) {
        if (at % 3 === 0) {
            commits.push({ sha, message: fields[at + 1] ?? '', ...patchAdds(fields[at + 2] ?? '') });
        }
    }
    return commits;
}
const TAG_OBJECT = /^object ([0-9a-f]+)$/;
/**
 * A tag as `git cat-file tag` prints it: header lines up to the first blank line, one of them `object <id>`, then the
 * message, a signature trailing it kept (it holds no secret, and scanning it costs nothing). Undefined without an
 * `object` line, which no tag git wrote lacks.
 */
export function tagOf(text) {
    const end = text.indexOf('\n\n');
    const headers = (end === -1 ? text : text.slice(0, end)).split('\n');
    const object = headers.map((line) => TAG_OBJECT.exec(line)?.[1]).find((sha) => sha !== undefined);
    return object === undefined ? undefined : { object, message: end === -1 ? '' : text.slice(end + 2) };
}
/** A commit message's lines as the commit will hold them: a verbose commit's diff below the scissors line is left out. */
export function messageLines(message) {
    const lines = message.split('\n');
    const scissors = lines.findIndex((line) => SCISSORS.test(line));
    return scissors === -1 ? lines : lines.slice(0, scissors);
}
