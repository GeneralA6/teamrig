/**
 * Where the host keeps its files on a machine. The core asks here for a place and joins no folder or file name of
 * the host's own, so a host that keeps them elsewhere, or under other names, changes only its adapter.
 */
export interface HostPaths {
  /** The host's own folder for the person whose home folder is `userHome`: its settings, plugins and session files. */
  home(userHome: string): string;
  /** The folder the host keeps its temporary files under, on a machine whose temporary folder is `systemTemp`. */
  temp(systemTemp: string): string;
  /** The folder the host loads that person's own skills from, in every project. */
  skills(userHome: string): string;
}
