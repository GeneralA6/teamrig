/**
 * Where the host keeps its files on a machine. The core asks here for a place and joins no folder or file name of
 * the host's own, so a host that keeps them elsewhere, or under other names, changes only its adapter. A place that
 * stands for many folders is one pattern, in which `*` is one folder name.
 */

/**
 * One settings file the host reads in a folder: a `shared` one is committed with the folder's repository, a `local`
 * one is the person's own there.
 */
export interface FolderSettings {
  readonly path: string;
  readonly kind: 'shared' | 'local';
}

export interface HostPaths {
  /** The host's own folder for the person whose home folder is `userHome`: its settings, plugins and session files. */
  home(userHome: string): string;
  /** The settings file the host reads for that person in every project. */
  userSettings(userHome: string): string;
  /** The settings files the host reads in `folder`, a project's folder or one of its worktrees, in the order it reads them. */
  folderSettings(folder: string): readonly FolderSettings[];
  /** The folder the host makes its own worktrees of the project in `project` in. */
  worktrees(project: string): string;
  /**
   * For a path at or below one of the host's own worktrees of a project, the same place in that project's folder: such
   * a worktree is a temporary copy of the project. Undefined for any other path.
   */
  worktreeRepo(path: string): string | undefined;
  /** The instruction file the host loads for that person in every project. */
  userInstructions(userHome: string): string;
  /**
   * The instruction files the host loads from `folder`, in the order it reads them: it reads a project's folder and
   * each folder above it at a session's start, and a folder below it once the session works there.
   */
  folderInstructions(folder: string): readonly string[];
  /** The folder the host loads that person's own rule files from, in every project. */
  userRules(userHome: string): string;
  /** The folder the host loads the rule files of the project in `project` from. */
  projectRules(project: string): string;
  /** The folder the host loads that person's own skills from, in every project. */
  skills(userHome: string): string;
  /** The folder the host loads the skills of the project in `project` from. */
  projectSkills(project: string): string;
  /** The folder the host loads that person's own agent types from, in every project. */
  userAgents(userHome: string): string;
  /** The folder the host loads the agent types of the project in `project` from. */
  projectAgents(project: string): string;
  /** The folder the host keeps that person's memory of the project in `project` in. */
  memoryFolder(userHome: string, project: string): string;
  /** The index of that memory: the one file of it the host loads into every session of the project. */
  memoryIndex(userHome: string, project: string): string;
  /** The memory folders the host keeps for that person, one per project, as one pattern. */
  memoryFolders(userHome: string): string;
  /** The scratchpad folders of every session, on a machine whose temporary folder is `systemTemp`, as one pattern. */
  scratchpads(systemTemp: string): string;
  /** The scratchpad folder the host gives the session whose transcript is the file `transcript`, on that machine. */
  scratchpadOf(transcript: string, systemTemp: string): string;
  /** The file the host keeps the plan of the session it named `slug` in. */
  planFile(userHome: string, slug: string): string;
  /** The folder of the snapshots the host takes of that person's shell and sources before each shell call. */
  shellSnapshots(userHome: string): string;
}
