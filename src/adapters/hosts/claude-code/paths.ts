import { basename, dirname, join, posix, win32 } from 'node:path';
import type { HostDeps, HostPaths } from '../../../plugin-api/index.ts';

/** Moves Claude Code's own folder (settings, plugins, transcripts) away from `~/.claude`. */
const CONFIG_DIR = 'CLAUDE_CONFIG_DIR';
/** Moves Claude Code's temporary files, session scratchpads among them, away from the system's temporary folder. */
const TEMP_DIR = 'CLAUDE_CODE_TMPDIR';

/** The folder Claude Code keeps a project's own files in, under the project folder or one of its worktrees. */
const PROJECT_DIR = '.claude';
/** The settings files in that folder, in the order Claude Code reads them, with whose each one is. */
const FOLDER_SETTINGS = [
  ['settings.json', 'shared'],
  ['settings.local.json', 'local'],
] as const;
/** The instruction files Claude Code reads in a folder, as path parts below it, in the order it reads them. */
const FOLDER_INSTRUCTIONS: readonly (readonly string[])[] = [['CLAUDE.md'], ['CLAUDE.local.md'], [PROJECT_DIR, 'CLAUDE.md']];
/** The index of a project's memory, the one memory file Claude Code loads at a session's start. */
const MEMORY_INDEX = 'MEMORY.md';
/** The files in Claude Code's own folder whose content is a secret: its login, and every prompt a person typed. */
const OWN_FOLDER_SECRETS = ['.credentials.json', 'history.jsonl'] as const;
/**
 * Claude Code's files whose content is a secret, as the secret guard's globs: those of its own folder where it is
 * by default, and a folder's local settings, whose allow rules keep a command allowed once, a credential in it too.
 */
const SECRET_FILES: readonly string[] = [...OWN_FOLDER_SECRETS.map((name) => `~/.claude/${name}`), `**/${PROJECT_DIR}/settings.local.json`];

/**
 * `folder`, an absolute path on `platform`, as a glob of the secret guard that fits that folder: forward slashes, `.`
 * and `..` resolved, no slash at its end, and each wildcard character of its name made a one-character set, which
 * fits that character alone. A Windows path rooted with no drive is on the drive the session works on, which is not
 * known here, so its glob fits the folder on any drive; one on a network share names its place whole.
 */
function folderGlob(folder: string, platform: HostDeps['platform']): string {
  const slashed = folder.replaceAll('\\', '/');
  const literal = posix
    .normalize(slashed)
    .replace(/\/+$/, '')
    .replace(/[*?[]/g, (char) => `[${char}]`);
  const onSomeDrive = platform === 'win32' && !/^[A-Za-z]:/.test(literal) && !slashed.startsWith('//');
  return onSomeDrive ? `?:${literal}` : literal;
}

/**
 * The secret files of Claude Code's own folder where `CLAUDE_CONFIG_DIR` moved it: the guard keeps them there as it
 * does at the default place. None for a value that is no absolute path on `platform`: the folder it names hangs on
 * where the session started, which is not known here.
 */
function movedSecretFiles(env: HostDeps['env'], platform: HostDeps['platform']): readonly string[] {
  const moved = setIn(env, CONFIG_DIR);
  if (moved === undefined || !(platform === 'win32' ? win32 : posix).isAbsolute(moved)) {
    return [];
  }
  const folder = folderGlob(moved, platform);
  return OWN_FOLDER_SECRETS.map((name) => `${folder}/${name}`);
}

/** Claude Code's folder name for a project: its path with every character but a letter or digit made `-`. */
function projectSlug(project: string): string {
  return project.replace(/[^A-Za-z0-9]/g, '-');
}

/** The variable's value, or undefined when it is unset or blank: a blank one moves nothing. */
function setIn(env: HostDeps['env'], name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** Platforms whose default filesystems (NTFS, APFS) ignore case, so a folder's name matches there in any case. */
const CASE_BLIND: ReadonlySet<HostDeps['platform']> = new Set(['win32', 'darwin']);
/** One of Claude Code's worktrees in a path, `<project>/.claude/worktrees/<name>`, with either separator. */
const WORKTREE = /[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/;
const WORKTREE_ANY_CASE = new RegExp(WORKTREE.source, 'i');

/**
 * For a path at or below a worktree Claude Code made (`<project>/.claude/worktrees/<name>[/<rest>]`, by EnterWorktree
 * or `claude --worktree`), the same place in the project's folder (`<project>[/<rest>]`); undefined for any other
 * path. A project at a root stays a root: the root keeps its separator.
 */
function worktreeRepoOf(path: string, platform: HostDeps['platform']): string | undefined {
  const match = (CASE_BLIND.has(platform) ? WORKTREE_ANY_CASE : WORKTREE).exec(path);
  if (match === null) {
    return undefined;
  }
  const head = path.slice(0, match.index);
  const tail = path.slice(match.index + match[0].length);
  const atRoot = tail === '' && (head === '' || head.endsWith(':'));
  return atRoot ? `${head}${(platform === 'win32' ? win32 : posix).sep}` : `${head}${tail}`;
}

/** Where Claude Code keeps its files, in the environment of one run on `platform`. */
export function hostPaths(env: HostDeps['env'], platform: HostDeps['platform']): HostPaths {
  const home = (userHome: string): string => setIn(env, CONFIG_DIR) ?? join(userHome, '.claude');
  /** Its temporary files: a session's scratchpad is `<it>/<project folder>/<session>/scratchpad`. */
  const temp = (systemTemp: string): string => join(setIn(env, TEMP_DIR) ?? systemTemp, 'claude');
  /** A project's memory: `<its folder>/projects/<the project's folder name>/memory`. */
  const memoryFolder = (userHome: string, project: string): string => join(home(userHome), 'projects', projectSlug(project), 'memory');
  return {
    home,
    userSettings: (userHome) => join(home(userHome), 'settings.json'),
    folderSettings: (folder) => FOLDER_SETTINGS.map(([name, kind]) => ({ path: join(folder, PROJECT_DIR, name), kind })),
    worktrees: (project) => join(project, PROJECT_DIR, 'worktrees'),
    worktreeRepo: (path) => worktreeRepoOf(path, platform),
    userInstructions: (userHome) => join(home(userHome), 'CLAUDE.md'),
    folderInstructions: (folder) => FOLDER_INSTRUCTIONS.map((parts) => join(folder, ...parts)),
    userRules: (userHome) => join(home(userHome), 'rules'),
    projectRules: (project) => join(project, PROJECT_DIR, 'rules'),
    skills: (userHome) => join(home(userHome), 'skills'),
    projectSkills: (project) => join(project, PROJECT_DIR, 'skills'),
    userAgents: (userHome) => join(home(userHome), 'agents'),
    projectAgents: (project) => join(project, PROJECT_DIR, 'agents'),
    memoryFolder,
    memoryIndex: (userHome, project) => join(memoryFolder(userHome, project), MEMORY_INDEX),
    memoryFolders: (userHome) => join(home(userHome), 'projects', '*', 'memory'),
    scratchpads: (systemTemp) => join(temp(systemTemp), '*', '*', 'scratchpad'),
    // A transcript is `<project folder>/<session>.jsonl`, and the scratchpad keeps both names.
    scratchpadOf: (transcript, systemTemp) => join(temp(systemTemp), basename(dirname(transcript)), basename(transcript, '.jsonl'), 'scratchpad'),
    planFile: (userHome, slug) => join(home(userHome), 'plans', `${slug}.md`),
    shellSnapshots: (userHome) => join(home(userHome), 'shell-snapshots'),
    // The default place stays named when the folder is moved: the files of an earlier run may still be there.
    secretFiles: () => [...SECRET_FILES, ...movedSecretFiles(env, platform)],
  };
}
