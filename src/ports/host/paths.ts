/**
 * Where the host keeps its files on a machine. The core asks here for a place and joins no folder or file name of
 * the host's own, so a host that keeps them elsewhere, or under other names, changes only its adapter. A place that
 * stands for many folders is one pattern, in which `*` is one folder name.
 */
export interface HostPaths {
  /** The host's own folder for the person whose home folder is `userHome`: its settings, plugins and session files. */
  home(userHome: string): string;
  /** The folder the host loads that person's own skills from, in every project. */
  skills(userHome: string): string;
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
