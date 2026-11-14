import * as nodePath from 'node:path';
import { bashDrivePath, resolveDir } from "../push-guard/location.js";
import { globRegExp, hasWildcard } from "./glob.js";
/**
 * The files whose content is a secret, and how a word on a command line names one. A team's own globs come after
 * these, in order, and the last glob that matches a path decides, as in a `.gitignore`: `!glob` keeps a path readable.
 * Claude Code's own stores and the shells' histories are among them: a secret typed or allowed once stays in them.
 */
export const DEFAULT_SECRET_PATHS = [
    '**/.env',
    '**/.env.*',
    '!**/.env.example',
    '!**/.env.sample',
    '~/.npmrc',
    '~/.ssh/**',
    '!~/.ssh/*.pub',
    '~/.aws/credentials',
    '**/.kube/config',
    '~/.docker/config.json',
    '**/.git-credentials',
    '~/.config/gh/hosts.yml',
    '~/.claude/.credentials.json',
    '~/.claude/history.jsonl',
    '**/.claude/settings.local.json',
    '~/.bash_history',
    '~/.zsh_history',
    '**/PSReadLine/*_history.txt',
    '**/*.pem',
    '**/*.key',
    '**/*.p12',
    '**/*.pfx',
    '**/*.jks',
    '**/*.keystore',
    '**/id_rsa',
    '**/id_ecdsa',
    '**/id_ed25519',
    // Terraform's state holds the secrets it creates in plain text.
    '**/*.tfstate',
    '**/*.tfstate.backup',
];
/** Stands for a part of a path only known when the line runs: it matches inside a `*` or `**`, never a name a glob spells out. */
const UNKNOWN = '\u0000';
/** The secret files of a team: the defaults, then its own globs. */
export class SecretPaths {
    globs;
    ignoreCase;
    /** `home` anchors `~/`; `ignoreCase` is true on hosts whose file names ignore case. */
    constructor(globs, home, ignoreCase) {
        this.ignoreCase = ignoreCase;
        const anchor = normalisePath(home);
        this.globs = globs.map((glob) => compileGlob(glob, anchor, ignoreCase));
    }
    /** True when the file at `path`, an absolute path, holds a secret. */
    listed(path) {
        return this.decide(normalisePath(path));
    }
    /**
     * True when a word naming `path` may name a secret file: the path itself is one, or, when it holds wildcards, one
     * of the secret names fits them (`.env*` fits `.env`). A last name of wildcards alone (`dir/*`) is tried only
     * against the globs that let it (see `CompiledGlob.wildcardAlone`), else every `grep x *` would name a `*.pem` it
     * cannot see. `dotfiles` is false for a bash word, whose wildcards never match a leading dot.
     */
    mayName(path, dotfiles) {
        const normal = normalisePath(path);
        if (!hasWildcard(normal)) {
            return this.decide(normal);
        }
        const options = { ignoreCase: this.ignoreCase, dotfiles };
        const word = globRegExp(normal, options);
        const folder = normal.slice(0, normal.lastIndexOf('/') + 1).replace(/[*?]|\[[^\]/]+\]/g, 'x');
        const onlyWildcards = /^(?:[*?]|\[[^\]/]+\])+$/.test(normal.slice(normal.lastIndexOf('/') + 1));
        return this.globs.some((glob) => {
            const candidate = `${folder}${glob.sampleName}`;
            const tried = !onlyWildcards || glob.wildcardAlone;
            return tried && !glob.keep && word.test(candidate) && this.decide(candidate);
        });
    }
    decide(path) {
        let secret = false;
        for (const glob of this.globs) {
            if (glob.pattern.test(path)) {
                secret = !glob.keep;
            }
        }
        return secret;
    }
}
/** `glob` anchored as the guard reads it: `~/` at home, an absolute glob where it says, any other at any depth. */
function compileGlob(glob, home, ignoreCase) {
    const keep = glob.startsWith('!');
    const body = (keep ? glob.slice(1) : glob).replaceAll('\\', '/');
    const options = { ignoreCase, dotfiles: true };
    const anchored = body === '~' || body.startsWith('~/') ? `${escapeGlob(home)}${body.slice(1)}` : isAbsolute(body) ? body : `**/${body.replace(/^\*\*\//, '')}`;
    const last = anchored.slice(anchored.lastIndexOf('/') + 1);
    const folderSpelled = anchored
        .slice(0, anchored.lastIndexOf('/'))
        .split('/')
        .some((part) => part !== '' && !hasWildcard(part));
    return {
        keep,
        pattern: globRegExp(anchored, options),
        sampleName: last.replace(/\*\*?|\?/g, 'x').replace(/\[[^\]]*\]/g, 'x'),
        wildcardAlone: last === '**' || (!hasWildcard(last) && (folderSpelled || last.startsWith('.'))),
    };
}
function isAbsolute(path) {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}
/** `text` with every glob character escaped, so a home folder named `a[1]` stays literal. */
function escapeGlob(text) {
    return text.replace(/[*?[]/g, (char) => `[${char}]`);
}
/** `path` with forward slashes, `.` and `..` resolved, and no trailing slash. */
export function normalisePath(path) {
    const slashed = path.replaceAll('\\', '/');
    const normal = nodePath.posix.normalize(slashed);
    return normal.length > 1 && normal.endsWith('/') && !/^[A-Za-z]:\/$/.test(normal) ? normal.slice(0, -1) : normal;
}
/** The variables that name the home folder, in each dialect's spelling. */
const HOME_VARIABLES = {
    bash: /\$(?:\{(?:HOME|USERPROFILE)\}|(?:HOME|USERPROFILE)\b)/g,
    powershell: /\$(?:\{env:(?:HOME|USERPROFILE)\}|env:(?:HOME|USERPROFILE)\b|HOME\b)/gi,
    cmd: /%(?:HOME|USERPROFILE)%/gi,
};
/** Any other variable or substitution, only known when the line runs. */
const OTHER_PARTS = {
    bash: /\$(?:\{[^}]*\}|\([^)]*\)|\w+)|`[^`]*`/g,
    powershell: /\$(?:\{[^}]*\}|\([^)]*\)|[\w:]+)/g,
    cmd: /%[^%]+%/g,
};
/**
 * The absolute path a word names, as far as the line tells: `~` and the home variables are the home folder, any other
 * variable is a part only known when it runs, a relative path starts in the program's folder (or one only known when
 * it runs), and Git Bash's `/c/x` is `C:/x` on Windows.
 */
export function wordPath(text, place) {
    const expanded = text.replace(HOME_VARIABLES[place.dialect], () => place.home).replace(OTHER_PARTS[place.dialect], UNKNOWN);
    const native = place.dialect === 'bash' ? bashDrivePath(expanded, place.home) : expanded;
    return resolveDir(place.dir, native, place.home) ?? `${UNKNOWN}/${native}`;
}
