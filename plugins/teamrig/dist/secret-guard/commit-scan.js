/** The finding of a file the secret paths list: its content is a secret whatever it holds. */
export const DECLARED_FILE = 'a declared secret file';
/** How many characters of a commit's id name it in a finding, as `git log --oneline` shows it. */
const SHORT_SHA = 7;
/**
 * Finds the secrets a commit adds (T1480): a line in one of the write-time shapes (the set the guard and the redactor
 * use, so all three agree), a file the secret paths list, by name, whatever it holds (`.credentials.json` holds no
 * shape), and a message line in a shape. No allow marker and no test-folder exemption (T1099 §5): a test fixture is
 * built at run time.
 */
export class CommitScanner {
    shapes;
    paths;
    root;
    /** `root` is the repo's top folder: a repo-relative path is matched as `<root>/<path>`. */
    constructor(shapes, paths, root) {
        this.shapes = shapes;
        this.paths = paths;
        this.root = root;
    }
    /** The secrets a staged change adds: its declared secret files, then its lines, each once. */
    staged(adds) {
        return unique([...this.files(adds.paths, ''), ...this.lines(adds.lines, '')]);
    }
    /** The secrets a commit message holds, each named by its line, the first being line 1. */
    message(lines) {
        return unique(this.textFindings(lines, 'commit message'));
    }
    /** The secrets each pushed commit adds, in its patch and its message, each named by the commit's short id. */
    pushed(commits) {
        return unique(commits.flatMap((commit) => {
            const prefix = `${commit.sha.slice(0, SHORT_SHA)} `;
            return [...this.files(commit.paths, prefix), ...this.lines(commit.lines, prefix), ...this.textFindings(commit.message.split('\n'), `${prefix}commit message`)];
        }));
    }
    /** The secrets each pushed annotated tag's message holds, each named by the tag's short id and its message line. */
    tags(tags) {
        return unique(tags.flatMap((tag) => this.textFindings(tag.message.split('\n'), `${tag.sha.slice(0, SHORT_SHA)} tag message`)));
    }
    files(paths, prefix) {
        return paths.filter((path) => this.paths.listed(`${this.root}/${path}`)).map((path) => ({ where: `${prefix}${path}`, description: DECLARED_FILE }));
    }
    lines(lines, prefix) {
        return lines.flatMap(({ file, line, text }) => this.hits(`${prefix}${file}:${line}`, text));
    }
    /** A message's findings, each named `<label> line <n>`, the first line being 1. */
    textFindings(lines, label) {
        return lines.flatMap((text, at) => this.hits(`${label} line ${at + 1}`, text));
    }
    hits(where, text) {
        return this.shapes.hitsIn(text).map(({ description }) => ({ where, description }));
    }
}
/** `findings` without repeats, in order: a secret twice on one line is one finding. */
function unique(findings) {
    const seen = new Set();
    return findings.filter(({ where, description }) => {
        const key = `${where}\n${description}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
