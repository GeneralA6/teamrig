import { basename, dirname, join, relative, sep } from 'node:path';
import { pathKey } from "../core/paths.js";
import { CLAUDE_MD_FILES, claudeMemoryDir, foldersUp } from "../doctor/context-files.js";
import { NESTED_FOLDERS_MAX, nestedClaudeMd } from "../rules/places.js";
/** The parts of a Claude Code setup, each kept under `files/<kind>/` in a setup backup. */
export const SETUP_KINDS = ['user', 'project', 'parents', 'memory', 'team-skills'];
/** The folder beside a skills folder that a slimming parks its unused skills in. */
const PARKED_SKILLS = 'skills-parked';
/** {@link SetupLocations.teamSkills} for a team whose skills folder is `skills`: undefined when that is Claude Code's own. */
export function teamSkillsOf(skills, claudeDir) {
    return skills === undefined || pathKey(skills) === pathKey(join(claudeDir, 'skills')) ? undefined : skills;
}
/** The folders the team-skills kind keeps, below the folder that holds the team's skills folder. */
function teamSkillsFolders(teamSkills) {
    return [basename(teamSkills), PARKED_SKILLS];
}
/** In Claude Code's folder. `skills-parked` holds the skills a slimming parked, so a restore can take the parking back. */
const USER_FILES = [['CLAUDE.md'], ['settings.json'], ['settings.local.json']];
const USER_FOLDERS = ['rules', 'skills', PARKED_SKILLS, 'agents', 'commands', 'output-styles'].map((name) => [name]);
/** In the project folder. */
const PROJECT_FILES = [...CLAUDE_MD_FILES, ['.claude', 'settings.json'], ['.claude', 'settings.local.json']];
const PROJECT_FOLDERS = ['rules', 'skills', PARKED_SKILLS, 'agents', 'commands'].map((name) => ['.claude', name]);
/** Folders a walk never enters: what they hold is not setup, and can be large. */
const SKIPPED_NAMES = new Map([
    ['node_modules', 'installed packages'],
    ['.git', 'version control'],
]);
/** How many folders deep a walk goes below a named folder, so a link that loops back ends. */
export const WALK_DEPTH = 12;
/** Every file below `folder` (itself `depth` folders below a named one), sorted per folder, entering none in SKIPPED_NAMES. */
async function walk(ports, folder, depth, found, skipped) {
    for (const name of (await ports.files.list(folder)).sort()) {
        const path = join(folder, name);
        const kind = await ports.probe.kind(path);
        if (kind === 'file') {
            found.push(path);
        }
        else if (kind === 'folder') {
            const why = SKIPPED_NAMES.get(name) ?? (depth === WALK_DEPTH ? `deeper than ${WALK_DEPTH} folders` : undefined);
            if (why === undefined) {
                await walk(ports, path, depth + 1, found, skipped);
            }
            else {
                skipped.push({ path, why });
            }
        }
    }
}
/** The path below `root`, with forward slashes on every platform. */
function below(root, path) {
    return relative(root, path).split(sep).join('/');
}
/**
 * The files of the setup at `at`: Claude Code's own CLAUDE.md, settings and rules, skills, parked skills, agents,
 * commands and output styles; the project's CLAUDE.md files (its folders' too, as the rules scan finds them),
 * settings and `.claude` folders; the CLAUDE.md files of each folder above the project; the project's memory folder;
 * the team's own skills folder and the parked skills beside it.
 */
export async function findSetupPlaces(ports, at) {
    const files = [];
    const absent = [];
    const skipped = [];
    const seen = new Set();
    const missing = new Set();
    const add = (kind, root, prefix, path) => {
        const key = pathKey(path);
        if (!seen.has(key)) {
            seen.add(key);
            files.push({ kind, source: path, stored: `${prefix}/${below(root, path)}` });
        }
    };
    const notThere = (path) => {
        const key = pathKey(path);
        if (!missing.has(key)) {
            missing.add(key);
            absent.push(path);
        }
    };
    const named = async (kind, root, fileParts, folderParts) => {
        const prefix = `files/${kind}`;
        for (const parts of fileParts) {
            const path = join(root, ...parts);
            if ((await ports.probe.kind(path)) === 'file') {
                add(kind, root, prefix, path);
            }
            else {
                notThere(path);
            }
        }
        for (const parts of folderParts) {
            const path = join(root, ...parts);
            if ((await ports.probe.kind(path)) !== 'folder') {
                notThere(path);
                continue;
            }
            const found = [];
            await walk(ports, path, 0, found, skipped);
            found.forEach((file) => add(kind, root, prefix, file));
        }
    };
    await named('user', at.claudeDir, USER_FILES, USER_FOLDERS);
    await named('project', at.project, PROJECT_FILES, PROJECT_FOLDERS);
    const nested = await nestedClaudeMd(ports.files, ports.probe, at.project);
    nested.paths.forEach((path) => add('project', at.project, 'files/project', path));
    if (nested.capped) {
        skipped.push({ path: at.project, why: `CLAUDE.md looked for in the first ${NESTED_FOLDERS_MAX} folders below it only` });
    }
    const parents = foldersUp(at.project).slice(1);
    for (const [index, folder] of parents.entries()) {
        for (const parts of CLAUDE_MD_FILES) {
            const path = join(folder, ...parts);
            if ((await ports.probe.kind(path)) === 'file') {
                add('parents', folder, `files/parents/${index + 1}`, path);
            }
        }
    }
    await named('memory', claudeMemoryDir(at.claudeDir, at.project), [], [[]]);
    if (at.teamSkills !== undefined) {
        await named('team-skills', dirname(at.teamSkills), [], teamSkillsFolders(at.teamSkills).map((name) => [name]));
    }
    return { files, absent, skipped };
}
/** A stored path's parts after `files/<kind>/`: none empty, `.` or `..`, and no backslash that a Windows path would split on. */
function safeParts(parts) {
    return parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}
/**
 * Where a file a backup keeps under `stored` belongs for the setup at `at`, or undefined when `stored` is not a path
 * {@link findSetupPlaces} makes. A restore writes only there, so an edited manifest cannot aim it anywhere else.
 */
export function sourceOfStored(at, stored) {
    const [top, kind, ...rest] = stored.split('/');
    if (top !== 'files') {
        return undefined;
    }
    if (kind === 'parents') {
        const [levels, ...parts] = rest;
        const folder = levels !== undefined && /^[1-9]\d*$/.test(levels) ? foldersUp(at.project)[Number(levels)] : undefined;
        return folder !== undefined && safeParts(parts) ? join(folder, ...parts) : undefined;
    }
    if (kind === 'team-skills') {
        // The kind's root holds the team's whole home, so only its two folders are a place a restore may write.
        const teamSkills = at.teamSkills;
        const [folder] = rest;
        const kept = teamSkills !== undefined && folder !== undefined && teamSkillsFolders(teamSkills).includes(folder);
        return kept && safeParts(rest) ? join(dirname(teamSkills), ...rest) : undefined;
    }
    const root = kind === 'user' ? at.claudeDir : kind === 'project' ? at.project : kind === 'memory' ? claudeMemoryDir(at.claudeDir, at.project) : undefined;
    return root !== undefined && safeParts(rest) ? join(root, ...rest) : undefined;
}
