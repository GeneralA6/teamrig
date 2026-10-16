import { runDemo, type DemoRun, type DemoStep } from './demo.ts';
import { highlight, type Line, type TerminalScreen } from './terminal-svg.ts';

/**
 * The commands doc's picture: two Claude Code sessions running teamrig's commands, drawn from a demo run of the real
 * CLI (demo.ts), so a change to what the CLI prints changes the picture.
 */

/** A pane's lines: each command after a `$ ` prompt, then what it printed, with a blank line between commands. */
export function paneLines(runs: readonly DemoRun[]): Line[] {
  return runs.flatMap((run, index) => [...(index === 0 ? [] : [[]]), highlight(`$ ${run.command}`), ...run.output.map(highlight)]);
}

const runsOf = (runs: readonly DemoRun[], session: string): DemoRun[] => runs.filter((run) => run.session === session);

/** The lead hands out work and tells web about it; web reads its inbox and starts. */
export const COMMANDS_STEPS: readonly DemoStep[] = [
  { session: 'lead', argv: ['add', '--title', 'Card API', '--description', 'Save cards', '--priority', 'p1', '--owner', 'api'] },
  { session: 'lead', argv: ['add', '--title', 'Checkout', '--description', 'Pay by card', '--priority', 'p1', '--owner', 'web'] },
  { session: 'lead', argv: ['inbox', 'add', '--to', 'web', '--text', "T2 builds on T1's API"] },
  { session: 'web', argv: ['inbox', 'read'] },
  { session: 'web', argv: ['set', 'T2', '--status', 'in-progress'] },
];
/** Wide enough that no line is cut, narrow enough (~720 px) that GitHub shows it without shrinking the text. */
export const COMMANDS_COLUMNS = 88;

export async function commandsScreen(): Promise<TerminalScreen> {
  const runs = await runDemo(COMMANDS_STEPS);
  return {
    label: 'Four Claude Code tabs named lead, api, web and data. In the lead tab, the lead adds a task for api and one for web, and tells web its task is ready. In the web tab, web reads that note and starts its task.',
    tabs: ['lead', 'api', 'web', 'data'].map((label) => ({ label, active: label === 'lead' })),
    panes: [
      { title: 'lead: a Claude Code session; Claude runs these commands', lines: paneLines(runsOf(runs, 'lead')) },
      { title: 'web: another Claude Code session', lines: paneLines(runsOf(runs, 'web')) },
    ],
    layout: 'stacked',
  };
}
