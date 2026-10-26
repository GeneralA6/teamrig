import { basename, dirname, join, relative, sep } from 'node:path';
import type { Files } from '../core/files.ts';
import type { PathProbe } from '../core/path-probe.ts';
import { pathKey } from '../core/paths.ts';
import { CLAUDE_MD_FILES, claudeMemoryDir, foldersUp } from '../doctor/context-files.ts';
import { NESTED_FOLDERS_MAX, nestedClaudeMd } from '../rules/places.ts';

/** The parts of a Claude Code setup, each kept under `files/<kind>/` in a setup backup. */
export const SETUP_KINDS = ['user', 'project', 'parents', 'memory', 'team-skills'] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

/** Where a setup lives: Claude Code's own folder, the project its sessions start in and the team's own skills folder. */
export interface SetupLocations {
  readonly claudeDir: string;
  readonly project: string;
  /**
   * The team's skills folder (`paths.skills`) when it is not Claude Code's own, which the user kind keeps: the folder
   * setup scan reads and a slimming parks skills from. Undefined without a team or with the default folder.
   */
  readonly teamSkills: string | undefined;
}

/** The folder beside a skills folder that a slimming parks its unused skills in. */
const PARKED_SKILLS = 'skills-parked';

/** {@link SetupLocations.teamSkills} for a team whose skills folder is `skills`: undefined when that is Claude Code's own. */
export function teamSkillsOf(skills: string | undefined, claudeDir: string): string | undefined {
  return skills === undefined || pathKey(skills) === pathKey(join(claudeDir, 'skills')) ? undefined : skills;
}

/** The folders the team-skills kind keeps, below the folder that holds the team's skills folder. */
function teamSkillsFolders(teamSkills: string): readonly string[] {
  return [basename(teamSkills), PARKED_SKILLS];
}

/** One file of the setup: where it is, and where a backup keeps it (`files/<kind>/<its path below the kind's folder, with />`). */
export interface SetupFile {
  readonly kind: SetupKind;
  readonly source: string;
  readonly stored: string;
}

/** A folder the walk did not enter, and why. */
export interface SkippedFolder {
  readonly path: string;
  readonly why: string;
}

export interface SetupPlaces {
  /** Each setup file once: a path two kinds name (the project is the home folder) counts for the first. */
  readonly files: readonly SetupFile[];
  /** The named files and folders that are not there, so a backup records that they were looked for. */
  readonly absent: readonly string[];
  readonly skipped: readonly SkippedFolder[];
}

export interface PlacePorts {
  readonly files: Files;
  readonly probe: PathProbe;
}

/** In Claude Code's folder. `skills-parked` holds the skills a slimming parked, so a restore can take the parking back. */
const USER_FILES: readonly (readonly string[])[] = [['CLAUDE.md'], ['settings.json'], ['settings.local.json']];
const USER_FOLDERS: readonly (readonly string[])[] = ['rules', 'skills', PARKED_SKILLS, 'agents', 'commands', 'output-styles'].map((name) => [name]);
/** In the project folder. */
const PROJECT_FILES: readonly (readonly string[])[] = [...CLAUDE_MD_FILES, ['.claude', 'settings.json'], ['.claude', 'settings.local.json']];
const PROJECT_FOLDERS: readonly (readonly string[])[] = ['rules', 'skills', PARKED_SKILLS, 'agents', 'commands'].map((name) => ['.claude', name]);

/** Folders a walk never enters: what they hold is not setup, and can be large. */
const SKIPPED_NAMES: ReadonlyMap<string, string> = new Map([
  ['node_modules', 'installed packages'],
  ['.git', 'version control'],
]);

/** How many folders deep a walk goes below a named folder, so a link that loops back ends. */
export const WALK_DEPTH = 12;

/** Every file below `folder` (itself `depth` folders below a named one), sorted per folder, entering none in SKIPPED_NAMES. */
async function walk(ports: PlacePorts, folder: string, depth: number, found: string[], skipped: SkippedFolder[]): Promise<void> {
  for (const name of (await ports.files.list(folder)).sort()) {
    const path = join(folder, name);
    const kind = await ports.probe.kind(path);
    if (kind === 'file') {
      found.push(path);
    } else if (kind === 'folder') {
      const why = SKIPPED_NAMES.get(name) ?? (depth === WALK_DEPTH ? `deeper than ${WALK_DEPTH} folders` : undefined);
      if (why === undefined) {
        await walk(ports, path, depth + 1, found, skipped);
      } else {
        skipped.push({ path, why });
      }
    }
  }
}

/** The path below `root`, with forward slashes on every platform. */
function below(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/**
 * The files of the setup at `at`: Claude Code's own CLAUDE.md, settings and rules, skills, parked skills, agents,
 * commands and output styles; the project's CLAUDE.md files (its folders' too, as the rules scan finds them),
 * settings and `.claude` folders; the CLAUDE.md files of each folder above the project; the project's memory folder;
 * the team's own skills folder and the parked skills beside it.
 */
export async function findSetupPlaces(ports: PlacePorts, at: SetupLocations): Promise<SetupPlaces> {
  const files: SetupFile[] = [];
  const absent: string[] = [];
  const skipped: SkippedFolder[] = [];
  const seen = new Set<string>();
  const missing = new Set<string>();
  const add = (kind: SetupKind, root: string, prefix: string, path: string): void => {
    const key = pathKey(path);
    if (!seen.has(key)) {
      seen.add(key);
      files.push({ kind, source: path, stored: `${prefix}/${below(root, path)}` });
    }
  };
  const notThere = (path: string): void => {
    const key = pathKey(path);
    if (!missing.has(key)) {
      missing.add(key);
      absent.push(path);
    }
  };
  const named = async (kind: SetupKind, root: string, fileParts: readonly (readonly string[])[], folderParts: readonly (readonly string[])[]): Promise<void> => {
    const prefix = `files/${kind}`;
    for (const parts of fileParts) {
      const path = join(root, ...parts);
      if ((await ports.probe.kind(path)) === 'file') {
        add(kind, root, prefix, path);
      } else {
        notThere(path);
      }
    }
    for (const parts of folderParts) {
      const path = join(root, ...parts);
      if ((await ports.probe.kind(path)) !== 'folder') {
        notThere(path);
        continue;
      }
      const found: string[] = [];
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
function safeParts(parts: readonly string[]): boolean {
  return parts.length > 0 && parts.every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}

/**
 * Where a file a backup keeps under `stored` belongs for the setup at `at`, or undefined when `stored` is not a path
 * {@link findSetupPlaces} makes. A restore writes only there, so an edited manifest cannot aim it anywhere else.
 */
export function sourceOfStored(at: SetupLocations, stored: string): string | undefined {
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
