import type { TerminalChoice } from '../config/types.ts';
import type { Env } from '../core/home.ts';
import { powerShellRequest } from '../core/powershell.ts';
import { candidatesOf, type OpenTabDeps } from './open-tab.ts';
import type { RunRequest } from './processes.ts';
import type { Terminal } from './terminals.ts';

/**
 * Bringing a running session's tab to the front (T1358 `meeting start`). The tab is the one titled with the session
 * (`[<team>] <name>`, sessionDisplay), after any mark Claude Code puts before the title. Windows Terminal selects it
 * through UI Automation and raises its window; tmux selects its window. No other terminal teamrig opens tabs in has a
 * call that selects a tab by its title. Nothing is typed into a terminal, and the title reaches the Windows script as
 * a variable, never inside it.
 */

/** The variable the Windows Terminal script reads the tab's title from. */
export const FOCUS_TITLE_VAR = 'TEAMRIG_FOCUS_TITLE';

/** The Windows Terminal script's exit codes: 0 selected and raised, 1 failed. */
export const FOCUS_EXIT = { noTab: 3, behind: 4 } as const;

/** How long the Windows Terminal script waits to see the raised window take the focus, in tries 100 ms apart. */
const RAISE_TRIES = 10;

/**
 * Windows PowerShell 5.1 over UI Automation, no package needed: it selects the first Windows Terminal tab whose name is
 * the title or ends with a space and the title, restores its window when minimized and gives it the focus. Windows'
 * foreground lock may keep another app's window in front: the tab is then selected in its window, and the script
 * exits FOCUS_EXIT.behind.
 */
export const WINDOWS_TERMINAL_FOCUS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Its first module load writes a progress record, which reaches a caller's stderr as CLIXML.
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
  '  $element = [System.Windows.Automation.AutomationElement]',
  '  $scope = [System.Windows.Automation.TreeScope]',
  `  $title = $env:${FOCUS_TITLE_VAR}`,
  "  $windows = $element::RootElement.FindAll($scope::Children, [System.Windows.Automation.PropertyCondition]::new($element::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS'))",
  '  $tabItem = [System.Windows.Automation.PropertyCondition]::new($element::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)',
  '  foreach ($window in $windows) {',
  '    foreach ($tab in $window.FindAll($scope::Descendants, $tabItem)) {',
  '      $name = $tab.Current.Name',
  "      if ($name -cne $title -and -not $name.EndsWith(' ' + $title, [StringComparison]::Ordinal)) { continue }",
  '      $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()',
  '      $shape = $window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)',
  '      if ($shape.Current.WindowVisualState -eq [System.Windows.Automation.WindowVisualState]::Minimized) { $shape.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal) }',
  '      try { $window.SetFocus() } catch { }',
  '      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
  `      for ($try = 0; $try -lt ${RAISE_TRIES}; $try++) {`,
  '        $top = $element::FocusedElement',
  '        while ($top -ne $null) {',
  '          $parent = $walker.GetParent($top)',
  '          if ($parent -eq $null -or [System.Windows.Automation.Automation]::Compare($parent, $element::RootElement)) { break }',
  '          $top = $parent',
  '        }',
  '        if ($top -ne $null -and [System.Windows.Automation.Automation]::Compare($top, $window)) { exit 0 }',
  '        Start-Sleep -Milliseconds 100',
  '      }',
  `      exit ${FOCUS_EXIT.behind}`,
  '    }',
  '  }',
  `  exit ${FOCUS_EXIT.noTab}`,
  '} catch {',
  '  exit 1',
  '}',
].join('\n');

/** The program that brings the tab titled `title` to the front in `terminal`; undefined where the terminal has none. */
export function focusRequest(terminal: Terminal, title: string, env: Env, cwd: string): RunRequest | undefined {
  switch (terminal) {
    case 'windows-terminal': {
      const { program, args } = powerShellRequest(WINDOWS_TERMINAL_FOCUS_SCRIPT);
      return { command: program, args, cwd, env: { ...env, [FOCUS_TITLE_VAR]: title } };
    }
    case 'tmux':
      // `=` takes the window named exactly so: a title's brackets are no pattern.
      return { command: 'tmux', args: ['select-window', '-t', `=${title}`], cwd, env };
    case 'macos-terminal':
    case 'gnome-terminal':
    case 'konsole':
    case 'x-terminal-emulator':
      return undefined;
  }
}

/** The tab brought to the front, the tab selected behind another app's window, or none, with why. */
export type FocusOutcome =
  | { readonly kind: 'focused'; readonly terminal: Terminal }
  | { readonly kind: 'behind'; readonly terminal: Terminal }
  | { readonly kind: 'none'; readonly reasons: readonly string[] };

/** Why `terminal` found no tab, from its exit code. */
function missedWhy(terminal: Terminal, title: string, code: number): string {
  if (terminal === 'tmux') {
    return `tmux has no window named ${title} (exit ${code})`;
  }
  return code === FOCUS_EXIT.noTab ? `no Windows Terminal tab is titled ${title}` : `Windows Terminal could not be searched (exit ${code})`;
}

/** Brings the tab titled `title` to the front in the chosen terminal, or the first `auto` finds that has it. */
export async function focusTab(deps: OpenTabDeps, choice: TerminalChoice, title: string, cwd: string): Promise<FocusOutcome> {
  const reasons: string[] = [];
  const titleless: Terminal[] = [];
  for (const terminal of candidatesOf(choice, deps)) {
    const request = focusRequest(terminal, title, deps.env, cwd);
    if (request === undefined) {
      titleless.push(terminal);
      continue;
    }
    const outcome = await deps.processes.run(request);
    if (outcome.kind === 'missing') {
      reasons.push(`${terminal} is not installed`);
    } else if (outcome.kind === 'failed') {
      reasons.push(`${terminal} failed: ${outcome.error}`);
    } else if (outcome.code === 0) {
      return { kind: 'focused', terminal };
    } else if (terminal === 'windows-terminal' && outcome.code === FOCUS_EXIT.behind) {
      return { kind: 'behind', terminal };
    } else {
      reasons.push(missedWhy(terminal, title, outcome.code));
    }
  }
  if (titleless.length > 0) {
    reasons.push(`${titleless.join(', ')} cannot select a tab by its title`);
  }
  return { kind: 'none', reasons: reasons.length === 0 ? ['the terminal setting is print'] : reasons };
}
