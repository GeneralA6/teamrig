import type { Env } from '../core/home.ts';
import type { RunRequest } from '../open/processes.ts';

/**
 * What the UI reads from its environment to call teamrig back: this CLI's entry script and the Node.js running it.
 * The UI is its own program with none of teamrig's code, and a terminal a person opened may have no `teamrig` on
 * PATH, so `teamrig ui` hands it the very CLI that started it.
 */
export const UI_ENV = { cli: 'TEAMRIG_CLI', node: 'TEAMRIG_NODE' } as const;

export interface UiStart {
  /** The UI's entry script. */
  readonly entry: string;
  /** The Node.js program running this CLI, which runs the UI too. */
  readonly node: string;
  /** This CLI's entry script. */
  readonly script: string;
  /** The team the UI shows. */
  readonly team: string;
  /** The session whose view it opens on; absent: the team's. */
  readonly session?: string;
  readonly cwd: string;
  readonly env: Env;
}

/** The UI as one program run in this terminal: `node <entry> --team <team> [--session <id>]`, in the caller's folder. */
export function uiRequest(start: UiStart): RunRequest {
  return {
    command: start.node,
    args: [start.entry, '--team', start.team, ...(start.session === undefined ? [] : ['--session', start.session])],
    cwd: start.cwd,
    env: { ...start.env, [UI_ENV.cli]: start.script, [UI_ENV.node]: start.node },
  };
}
