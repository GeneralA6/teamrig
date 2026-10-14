import type { TerminalChoice } from '../config/types.ts';
import type { Env } from '../core/home.ts';
import type { Processes } from './processes.ts';
import { autoTerminals, tabCommand, type TabRequest, type Terminal } from './terminals.ts';

/** A tab opened in `terminal`, or none, with why each terminal tried could not open it. */
export type OpenOutcome = { readonly kind: 'opened'; readonly terminal: Terminal } | { readonly kind: 'none'; readonly reasons: readonly string[] };

export interface OpenTabDeps {
  readonly processes: Processes;
  readonly env: Env;
  readonly platform: NodeJS.Platform;
}

function candidatesOf(choice: TerminalChoice, deps: OpenTabDeps): readonly Terminal[] {
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
        return { kind: 'opened', terminal };
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
