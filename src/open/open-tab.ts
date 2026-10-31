import type { TerminalChoice } from '../config/types.ts';
import type { Env } from '../core/home.ts';
import { EXIT_WAIT_MS, type LaunchEnd, type Processes } from './processes.ts';
import { autoTerminals, tabCommand, type TabRequest, type Terminal } from './terminals.ts';

/** A tab opened in `terminal`, and how its launcher ended, or none, with why each terminal tried could not open it. */
export type OpenOutcome =
  | { readonly kind: 'opened'; readonly terminal: Terminal; readonly end: LaunchEnd }
  | { readonly kind: 'none'; readonly reasons: readonly string[] };

/** How an opened tab's launch ended, for a log: `windows-terminal exited 0`. */
export function launchWords(terminal: Terminal, end: LaunchEnd): string {
  switch (end) {
    case 'exited':
      return `${terminal} exited 0`;
    case 'running':
      return `${terminal} still running after ${EXIT_WAIT_MS / 1_000} s`;
    case 'spawned':
      return `${terminal} started`;
  }
}

export interface OpenTabDeps {
  readonly processes: Processes;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
}

/** The terminals a choice tries, in order: the one chosen, those `auto` finds, or none for `print`. */
export function candidatesOf(choice: TerminalChoice, deps: OpenTabDeps): readonly Terminal[] {
  switch (choice) {
    case 'auto':
      return autoTerminals(deps.env, deps.platform);
    case 'print':
      return [];
    default:
      return [choice];
  }
}

/** Opens the tab in the chosen terminal, or the first `auto` finds that works; `print` tries none. */
export async function openTab(deps: OpenTabDeps, choice: TerminalChoice, tab: TabRequest): Promise<OpenOutcome> {
  const reasons: string[] = [];
  for (const terminal of candidatesOf(choice, deps)) {
    const planned = tabCommand(terminal, tab);
    if (planned.kind === 'unusable') {
      reasons.push(planned.why);
      continue;
    }
    const outcome = await deps.processes.start(planned.request);
    switch (outcome.kind) {
      case 'started':
        return { kind: 'opened', terminal, end: outcome.end };
      case 'missing':
        reasons.push(`${terminal} is not installed`);
        break;
      case 'failed':
        reasons.push(`${terminal} failed: ${outcome.error}`);
        break;
    }
  }
  return { kind: 'none', reasons: reasons.length === 0 ? ['the terminal setting is print'] : reasons };
}
