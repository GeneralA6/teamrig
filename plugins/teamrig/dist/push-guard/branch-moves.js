const REPO = { kind: 'repo' };
const UNKNOWN = { kind: 'unknown' };
/** `checkout` / `switch` options that take a value as the next word. */
const CHECKOUT_VALUED = new Set(['--conflict', '--pathspec-from-file']);
/** Options that create a branch, with the new name as their value. */
const CREATE_OPTIONS = new Set(['-b', '-B', '-c', '-C', '--orphan', '--create', '--force-create']);
const BRANCH_RETARGETS = new Set(['-m', '-M', '--move', '-u', '--set-upstream-to', '--unset-upstream']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', 'get', 'list']);
/** `git branch` options that only list or show branches, so its operands are patterns or commits, not a branch it makes. */
const BRANCH_LISTS = new Set(['--list', '-l', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--show-current']);
/** `git branch` options that set, copy or drop an upstream: its config moves with a renamed or copied branch. */
const BRANCH_UPSTREAMS = new Set([...BRANCH_RETARGETS, '-t', '--track', '-c', '-C', '--copy']);
/** `checkout` and `switch` options that may give a branch an upstream: a new branch from a remote one, or `--track`. */
const UPSTREAM_SETTERS = new Set([...CREATE_OPTIONS, '-t', '--track']);
/** `git remote` subcommands that rename or drop a remote's keys, `remote.<name>.push` and `branch.<name>.remote` among them. */
const REMOTE_REWRITES = new Set(['add', 'rename', 'remove', 'rm']);
/** True when a `git config` writes a remote, push or branch key. */
function writesPushConfig(texts) {
    return !texts.some((text) => CONFIG_READS.has(text)) && texts.some((text) => /^(?:remote|push|branch)\./i.test(text));
}
/** The option name of a word, without an attached `=value`. */
function optionName(text) {
    return text.split('=')[0] ?? '';
}
/** The operands of a git command: words that are no option, before any `--`. */
function operands(args) {
    const found = [];
    for (const arg of args) {
        if (arg.text === '--') {
            break;
        }
        if (!arg.text.startsWith('-')) {
            found.push(arg);
        }
    }
    return found;
}
/**
 * Tracks branch changes within one command line, so `git checkout main && git push` is judged on `main`,
 * not on the branch checked out before the line ran. Views are per folder; a move in one folder makes every
 * other folder's view unknown, since the guard cannot tell whether they share a repository.
 */
export class BranchMoves {
    views = new Map();
    othersUnknown = false;
    change = 'none';
    protectedBranches;
    constructor(protectedBranches) {
        this.protectedBranches = protectedBranches;
    }
    /** The view of the repository in `dir` at this point of the line. */
    view(dir) {
        return this.views.get(dir) ?? (this.othersUnknown ? UNKNOWN : REPO);
    }
    /**
     * What the line so far may have changed of where a branch named alone pushes, in any folder: worktrees share their
     * repository's config, and the guard cannot tell which folders do.
     */
    mapChange() {
        return this.change;
    }
    /** Updates the views after one git command runs. */
    observe(invocation) {
        const change = mapChangeOf(invocation);
        if (change === 'config' || (change === 'upstream' && this.change === 'none')) {
            this.change = change;
        }
        const moved = this.moveOf(invocation);
        if (moved === undefined) {
            return;
        }
        for (const key of this.views.keys()) {
            this.views.set(key, UNKNOWN);
        }
        this.othersUnknown = true;
        if (invocation.dir !== undefined && moved !== 'everywhere') {
            this.views.set(invocation.dir, moved);
        }
    }
    /** How a command moves the branch of its folder; `everywhere` when it may move any repository's; undefined when it moves none. */
    moveOf({ subcommand, args, dir }) {
        const moved = this.localMove(subcommand, args);
        return moved !== undefined && dir === undefined ? 'everywhere' : moved;
    }
    localMove(subcommand, args) {
        const texts = args.map((arg) => arg.text);
        switch (subcommand) {
            case 'switch':
            case 'checkout':
                return this.checkout(subcommand, args);
            case 'branch':
                return texts.some((text) => BRANCH_RETARGETS.has(text.split('=')[0] ?? '')) ? UNKNOWN : undefined;
            case 'rebase':
                return operands(args).length >= 2 ? UNKNOWN : undefined;
            case 'bisect':
                return UNKNOWN;
            case 'config':
                return writesPushConfig(texts) ? 'everywhere' : undefined;
            default:
                return undefined;
        }
    }
    /** `switch X`, `switch -c X [start]`, `checkout -b X [start]`, `checkout X`; a file checkout (`-p`, `--`, several operands) moves nothing. */
    checkout(subcommand, args) {
        const positional = [];
        let created;
        let tracked = false;
        let detached = false;
        let paths = false;
        for (let index = 0; index < args.length; index += 1) {
            const arg = args[index] ?? { text: '', dynamic: false };
            const equals = arg.text.startsWith('--') ? arg.text.indexOf('=') : -1;
            const name = equals === -1 ? arg.text : arg.text.slice(0, equals);
            const attached = equals === -1 ? undefined : { text: arg.text.slice(equals + 1), dynamic: arg.dynamic };
            if (arg.text === '--' || name === '-p' || name === '--patch') {
                paths = true;
                break;
            }
            if (CREATE_OPTIONS.has(name) && (subcommand === 'switch' || !/^(?:-[cC]|--create|--force-create)$/.test(name))) {
                created = attached ?? args[(index += 1)];
            }
            else if (name === '-t' || name === '--track') {
                tracked = true;
            }
            else if (name === '-d' || name === '--detach' || name === '-') {
                detached = true;
            }
            else if (CHECKOUT_VALUED.has(name) && attached === undefined) {
                index += 1;
            }
            else if (!arg.text.startsWith('-')) {
                positional.push(arg);
            }
        }
        if (created !== undefined) {
            return created.dynamic ? UNKNOWN : { kind: 'branch', branch: created.text, target: tracked || positional.length > 0 ? 'unknown' : 'same' };
        }
        if (detached) {
            return UNKNOWN;
        }
        const [target, ...more] = positional;
        if (target === undefined || paths || more.length > 0) {
            return undefined;
        }
        if (target.dynamic) {
            return UNKNOWN;
        }
        // `checkout X` may restore a file named X instead; only a protected name is trusted as a branch.
        if (subcommand === 'checkout' && !this.protectedBranches.has(target.text)) {
            return UNKNOWN;
        }
        return { kind: 'branch', branch: target.text, target: tracked ? 'unknown' : 'read' };
    }
}
/** What one git command may change of where a branch named alone pushes (see `namedPushTarget`). */
function mapChangeOf({ subcommand, args }) {
    const texts = args.map((arg) => arg.text);
    const options = texts.filter((text) => text.startsWith('-')).map(optionName);
    const [first] = operands(args);
    switch (subcommand) {
        case 'config':
            return writesPushConfig(texts) ? 'config' : 'none';
        case 'remote':
            return first !== undefined && REMOTE_REWRITES.has(first.text) ? 'config' : 'none';
        case 'branch':
            if (options.some((option) => BRANCH_LISTS.has(option))) {
                return 'none';
            }
            return first !== undefined || options.some((option) => BRANCH_UPSTREAMS.has(option)) ? 'upstream' : 'none';
        case 'checkout':
        case 'switch':
            return options.some((option) => UPSTREAM_SETTERS.has(option)) ? 'upstream' : 'none';
        case 'worktree':
            return first?.text === 'add' ? 'upstream' : 'none';
        default:
            return 'none';
    }
}
