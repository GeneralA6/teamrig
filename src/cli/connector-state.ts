import { join } from 'node:path';
import type { TeamPaths } from '../core/home.ts';
import { ADAPTER_ID } from '../plugin-api/index.ts';

/** The folder under the team's state that holds one folder per connector. */
const CONNECTORS_FOLDER = 'connectors';

/**
 * Where one connector keeps what it remembers of a team between runs, all under its own folder so two connectors of
 * a team never share a file. The files are those an issue tracker's sync, watch and claims need.
 */
export interface ConnectorState {
  /** `<state>/connectors/<id>`: every path below is inside it. */
  readonly dir: string;
  /** The automatic sync's last start, finish and failing targets. */
  readonly sync: string;
  /** Held while a sync records its finish. */
  readonly syncLock: string;
  /** The end of each failed CI job's log of a session's own pull request, one file per pull request. */
  readonly ci: string;
  /** The automatic status push's writes per minute over the last hour. */
  readonly pushHour: string;
  /** The response clock of each thread waiting on an answer of ours. */
  readonly clocks: string;
  /** The lease of the team's one watch of this connector: its pid and last beat. */
  readonly watch: string;
  /** Held while a hook claims the watch or the watch claims, renews or drops its lease. */
  readonly watchLock: string;
  /** The issues and pull requests each session follows. */
  readonly follows: string;
  /** The issue claims the sync made, the only assignees it may ever take off. */
  readonly claims: string;
}

/**
 * The state paths of the connector of an id. The id becomes a folder name, so one that is no adapter id (a `..`, a
 * separator, an upper-case letter that would name the same folder twice on a case-blind disk) is refused here, whoever
 * the caller is, rather than trusted to have been checked where the config was read.
 */
export function connectorState(paths: TeamPaths, id: string): ConnectorState {
  if (!ADAPTER_ID.test(id)) {
    throw new Error(`no connector state for ${JSON.stringify(id)}: a connector id is lower-case words joined by -`);
  }
  const dir = join(paths.state, CONNECTORS_FOLDER, id);
  return {
    dir,
    sync: join(dir, 'sync.json'),
    syncLock: join(dir, 'sync.lock'),
    ci: join(dir, 'ci'),
    pushHour: join(dir, 'push-hour.json'),
    clocks: join(dir, 'clocks.json'),
    watch: join(dir, 'watch.json'),
    watchLock: join(dir, 'watch.lock'),
    follows: join(dir, 'follows.json'),
    claims: join(dir, 'claims.json'),
  };
}
