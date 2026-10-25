import { extname, isAbsolute, join, resolve } from 'node:path';
import { isRecord } from "../core/guards.js";
import { expandHome, pathKey } from "../core/paths.js";
import { CLAUDE_MD_FILES, claudeMdPaths, claudeMemoryDir, skillFolders } from "../doctor/context-files.js";
import { claudeSettingsFiles, jsonObjectOf } from "../doctor/settings-env.js";
import { SkillDir } from "../skills/store.js";
/**
 * The kinds of place a local rule that can override a core rule lives in: CLAUDE.md files (the user's, the project's
 * and its parents', and those deeper in the project), `.claude/rules` files, skills, memory files, the team's own rules
 * file, scripts a settings hook runs (their output reaches the session) and the settings files' `autoMode` lines.
 */
export const PLACE_KINDS = ['claude-md', 'rules', 'skill', 'memory', 'team-rules', 'hook', 'settings'];
export function isPlaceKind(text) {
    return PLACE_KINDS.some((kind) => kind === text);
}
/** CLAUDE.md files are looked for this many folders below the project (`a/b/c/CLAUDE.md`), in at most this many folders. */
export const NESTED_DEPTH = 3;
export const NESTED_FOLDERS_MAX = 2_000;
/** Rules and memory folders are read this many folders deep. */
const MARKDOWN_DEPTH = 4;
/** Folders that hold installed, built or copied files, never a project's own rules. Hidden folders are skipped too. */
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target']);
/** A hook's command names a script by one of these extensions; the scan reads the script, as its output is text the session reads. */
const SCRIPT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.sh', '.ps1', '.py']);
/** The folders below `folder` worth searching for rules: neither hidden nor in SKIPPED_FOLDERS. */
async function subfolders(files, probe, folder) {
    const names = (await files.list(folder)).filter((name) => !name.startsWith('.') && !SKIPPED_FOLDERS.has(name)).sort();
    const kinds = await Promise.all(names.map(async (name) => ({ path: join(folder, name), kind: await probe.kind(join(folder, name)) })));
    return kinds.filter((entry) => entry.kind === 'folder').map((entry) => entry.path);
}
/** The CLAUDE.md files in folders 1 to NESTED_DEPTH below the project, breadth first, in at most NESTED_FOLDERS_MAX folders. */
export async function nestedClaudeMd(files, probe, project) {
    const paths = [];
    let level = await subfolders(files, probe, project);
    let visited = 0;
    for (let depth = 1; depth <= NESTED_DEPTH && level.length > 0; depth += 1) {
        const next = [];
        for (const folder of level) {
            if (visited === NESTED_FOLDERS_MAX) {
                return { paths, capped: true };
            }
            visited += 1;
            for (const parts of CLAUDE_MD_FILES) {
                const path = join(folder, ...parts);
                if ((await probe.kind(path)) === 'file') {
                    paths.push(path);
                }
            }
            if (depth < NESTED_DEPTH) {
                next.push(...(await subfolders(files, probe, folder)));
            }
        }
        level = next;
    }
    return { paths, capped: false };
}
/** The `.md` files in `folder` and its subfolders, up to MARKDOWN_DEPTH deep, sorted. */
async function markdownBelow(files, probe, folder, depth = 1) {
    const found = [];
    for (const name of (await files.list(folder)).sort()) {
        const path = join(folder, name);
        const kind = await probe.kind(path);
        if (kind === 'file' && extname(name).toLowerCase() === '.md') {
            found.push(path);
        }
        else if (kind === 'folder' && depth < MARKDOWN_DEPTH && !name.startsWith('.')) {
            found.push(...(await markdownBelow(files, probe, path, depth + 1)));
        }
    }
    return found;
}
/** The words of a shell command line, each with its quotes taken off. */
function commandWords(command) {
    return (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((word) => word.replace(/^(["'])(.*)\1$/, '$2'));
}
/** `~`, `$HOME` and `$CLAUDE_PROJECT_DIR` read as Claude Code's shell reads them; undefined for a plugin's own path. */
function expandWord(word, at) {
    if (word.includes('CLAUDE_PLUGIN_ROOT')) {
        return undefined;
    }
    const expanded = word
        .replace(/^(\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])/, at.userHome)
        .replace(/^(\$CLAUDE_PROJECT_DIR|\$\{CLAUDE_PROJECT_DIR\})(?=$|[\\/])/, at.project);
    return expandHome(expanded, at.userHome);
}
/** The command lines of every `command` hook in a settings object: the command and, in the exec form, its `args`. */
function hookCommandWords(settings) {
    const hooks = settings['hooks'];
    if (!isRecord(hooks)) {
        return [];
    }
    const groups = Object.values(hooks).flatMap((event) => (Array.isArray(event) ? event : []));
    const handlers = groups.flatMap((group) => (isRecord(group) && Array.isArray(group['hooks']) ? group['hooks'] : []));
    return handlers.flatMap((handler) => {
        if (!isRecord(handler) || typeof handler['command'] !== 'string') {
            return [];
        }
        const args = handler['args'];
        const extra = Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : [];
        return [[...commandWords(handler['command']), ...extra]];
    });
}
/** The scripts the settings files' hooks run, as absolute paths (a relative one is read from the project folder). */
async function hookScripts(files, settingsPaths, at) {
    const scripts = [];
    for (const path of settingsPaths) {
        const text = await files.read(path);
        const settings = text === undefined ? undefined : jsonObjectOf(text);
        for (const words of settings === undefined ? [] : hookCommandWords(settings)) {
            for (const word of words) {
                const expanded = expandWord(word, at);
                if (expanded !== undefined && SCRIPT_EXTENSIONS.has(extname(expanded).toLowerCase())) {
                    scripts.push(isAbsolute(expanded) ? expanded : resolve(at.project, expanded));
                }
            }
        }
    }
    return scripts;
}
/** The paths that are files, in order. */
async function existing(probe, paths) {
    const kinds = await Promise.all(paths.map((path) => probe.kind(path)));
    return paths.filter((_, index) => kinds[index] === 'file');
}
/**
 * Every file a local rule that can override a core rule lives in, for a session started in `at.project`. It only
 * reads. Not searched: files a CLAUDE.md imports with `@path`, plugins' own skills and hooks, and managed settings.
 */
export async function findRulePlaces(files, probe, at) {
    const nested = await nestedClaudeMd(files, probe, at.project);
    const settings = await existing(probe, claudeSettingsFiles(at.claudeDir, at.project));
    const skillPaths = (await Promise.all(skillFolders(at.skills, at.project).map(async (folder) => {
        const dir = new SkillDir(files, folder);
        return (await dir.readAll()).map((skill) => dir.pathOf(skill.name));
    }))).flat();
    const byKind = {
        'claude-md': [...(await existing(probe, claudeMdPaths(at.claudeDir, at.project))), ...nested.paths],
        rules: [
            ...(await markdownBelow(files, probe, join(at.project, '.claude', 'rules'))),
            ...(await markdownBelow(files, probe, join(at.claudeDir, 'rules'))),
        ],
        skill: skillPaths,
        memory: await markdownBelow(files, probe, claudeMemoryDir(at.claudeDir, at.project)),
        'team-rules': await existing(probe, [at.teamRules]),
        hook: await existing(probe, await hookScripts(files, settings, at)),
        settings,
    };
    const seen = new Set();
    const places = PLACE_KINDS.flatMap((kind) => byKind[kind].flatMap((path) => {
        const key = pathKey(path);
        if (seen.has(key)) {
            return [];
        }
        seen.add(key);
        return [{ kind, path }];
    }));
    return { places, nestedCapped: nested.capped };
}
