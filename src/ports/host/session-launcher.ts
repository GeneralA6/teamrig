/**
 * The host's sessions as the core starts, finds and names them. So far the port tells who the host says a run is;
 * its program, a launch, a resume, a session's processes and a wake join it as each moves out of the core.
 */

/**
 * What the host tells a run about the session that started it. A host tells it its own way (Claude Code in the
 * environment of its hooks and of what its tools run), so the core asks here and reads no variable of a host.
 */
export interface SessionIdentity {
  /**
   * The folder the host started the session in, which stays put through a `cd` or a worktree: where a command run
   * from a subfolder finds its team, and where a session is resumed from. Undefined when the host tells none, as
   * in a run no session started.
   */
  readonly projectDir: string | undefined;
  /**
   * How the host was started, in the host's own word, kept as told for a session's restore record; undefined when
   * it tells none.
   */
  readonly startedAs: string | undefined;
  /** The session's kind in the host's own word, kept as told for the same record; undefined when it tells none. */
  readonly sessionKind: string | undefined;
}

export interface SessionLauncher {
  /** Who the host says this run is, in the environment the port was built for. */
  identity(): SessionIdentity;
}
