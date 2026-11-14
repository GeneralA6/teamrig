import { powerShellRequest } from "../core/powershell.js";
import { EXIT_WAIT_MS } from "./processes.js";
import { windowsCommandLine } from "./quote.js";
/**
 * Opening a Windows Terminal tab that leaves the focus where it was (T2510): `wt.exe new-tab` always selects the new
 * tab and raises its window, and has no flag against it. So one Windows PowerShell script over UI Automation records
 * the window in front and the selected tab of every Windows Terminal window, starts the launcher, waits for the new
 * tab, then selects those tabs again and gives the front window the focus back. Windows' foreground lock may refuse
 * that last step; the tabs are reselected all the same. Nothing is typed into a terminal, and the launcher's program
 * and command line reach the script as variables, never inside it.
 */
/** The variable the script reads the launcher's program from. */
export const KEEP_FOCUS_PROGRAM_VAR = 'TEAMRIG_KEEP_FOCUS_PROGRAM';
/** The variable the script reads the launcher's arguments from, as one Windows command line (windowsCommandLine). */
export const KEEP_FOCUS_ARGS_VAR = 'TEAMRIG_KEEP_FOCUS_ARGS';
/**
 * The script's exit codes past 0 (opened, focus kept): the launcher still running after the wait, the tab opened but
 * the focus not given back, the launcher not installed, the launcher exited with an error. Any other code: the script
 * itself failed.
 */
export const KEEP_FOCUS_EXIT = { running: 10, focusLost: 11, missing: 12, launcherFailed: 13 };
/** How long the script waits for the new tab to show, and then for the front window to take the focus back, in tries 100 ms apart. */
const NEW_TAB_TRIES = 30;
const REFOCUS_TRIES = 10;
export const WINDOWS_TERMINAL_KEEP_FOCUS_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    // Its first module load writes a progress record, which reaches a caller's stderr as CLIXML.
    "$ProgressPreference = 'SilentlyContinue'",
    'try {',
    '  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
    '  $element = [System.Windows.Automation.AutomationElement]',
    '  $scope = [System.Windows.Automation.TreeScope]',
    '  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker',
    '  $selectionItem = [System.Windows.Automation.SelectionItemPattern]::Pattern',
    "  $isTerminal = [System.Windows.Automation.PropertyCondition]::new($element::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')",
    '  $tabItem = [System.Windows.Automation.PropertyCondition]::new($element::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)',
    // The top-level window holding the focus: the focused element, walked up to a child of the desktop.
    '  function Get-FrontWindow {',
    '    $top = $element::FocusedElement',
    '    while ($top -ne $null) {',
    '      $parent = $walker.GetParent($top)',
    '      if ($parent -eq $null -or [System.Windows.Automation.Automation]::Compare($parent, $element::RootElement)) { break }',
    '      $top = $parent',
    '    }',
    '    return $top',
    '  }',
    '  function Find-Tabs {',
    '    $tabs = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()',
    '    foreach ($window in $element::RootElement.FindAll($scope::Children, $isTerminal)) {',
    '      foreach ($tab in $window.FindAll($scope::Descendants, $tabItem)) { $tabs.Add($tab) }',
    '    }',
    '    return ,$tabs',
    '  }',
    // A failed record (a secure desktop in front, say) still opens the tab, with nothing to give back.
    '  $front = $null',
    '  $selected = [System.Collections.Generic.List[System.Windows.Automation.AutomationElement]]::new()',
    '  $before = 0',
    '  try {',
    '    $front = Get-FrontWindow',
    '    $tabs = Find-Tabs',
    '    $before = $tabs.Count',
    '    foreach ($tab in $tabs) { if ($tab.GetCurrentPattern($selectionItem).Current.IsSelected) { $selected.Add($tab) } }',
    '  } catch { $front = $null; $selected.Clear() }',
    `  $start = [System.Diagnostics.ProcessStartInfo]::new($env:${KEEP_FOCUS_PROGRAM_VAR}, $env:${KEEP_FOCUS_ARGS_VAR})`,
    '  $start.UseShellExecute = $false',
    '  try { $launcher = [System.Diagnostics.Process]::Start($start) } catch {',
    '    $base = $_.Exception.GetBaseException()',
    `    if ($base -is [System.ComponentModel.Win32Exception] -and $base.NativeErrorCode -eq 2) { exit ${KEEP_FOCUS_EXIT.missing} }`,
    `    exit ${KEEP_FOCUS_EXIT.launcherFailed}`,
    '  }',
    '  $code = 0',
    `  if (-not $launcher.WaitForExit(${EXIT_WAIT_MS})) { $code = ${KEEP_FOCUS_EXIT.running} } elseif ($launcher.ExitCode -ne 0) { exit ${KEEP_FOCUS_EXIT.launcherFailed} }`,
    '  if ($front -eq $null -and $selected.Count -eq 0) { exit $code }',
    `  for ($try = 0; $try -lt ${NEW_TAB_TRIES}; $try++) { if ((Find-Tabs).Count -gt $before) { break }; Start-Sleep -Milliseconds 100 }`,
    '  foreach ($tab in $selected) { try { $tab.GetCurrentPattern($selectionItem).Select() } catch { } }',
    '  if ($front -ne $null) {',
    '    try { $front.SetFocus() } catch { }',
    `    for ($try = 0; $try -lt ${REFOCUS_TRIES}; $try++) {`,
    '      $top = Get-FrontWindow',
    '      if ($top -ne $null -and [System.Windows.Automation.Automation]::Compare($top, $front)) { exit $code }',
    '      Start-Sleep -Milliseconds 100',
    '    }',
    `    if ($code -eq 0) { exit ${KEEP_FOCUS_EXIT.focusLost} }`,
    '  }',
    '  exit $code',
    '} catch {',
    '  exit 1',
    '}',
].join('\n');
/** The script run that starts `launcher` and keeps the focus. */
export function keepFocusRequest(launcher, env) {
    const { program, args } = powerShellRequest(WINDOWS_TERMINAL_KEEP_FOCUS_SCRIPT);
    return {
        command: program,
        args,
        cwd: launcher.cwd,
        env: { ...env, [KEEP_FOCUS_PROGRAM_VAR]: launcher.command, [KEEP_FOCUS_ARGS_VAR]: windowsCommandLine(launcher.args) },
    };
}
/** What the script's exit says of the launch, as a plain start would have said it. */
function startOutcomeOf(launcher, code) {
    switch (code) {
        case 0:
        // The tab is open; only the focus stayed with it, which no caller acts on.
        case KEEP_FOCUS_EXIT.focusLost:
            return { kind: 'started', end: 'exited' };
        case KEEP_FOCUS_EXIT.running:
            return { kind: 'started', end: 'running' };
        case KEEP_FOCUS_EXIT.missing:
            return { kind: 'missing' };
        case KEEP_FOCUS_EXIT.launcherFailed:
            return { kind: 'failed', error: `${launcher.command} exited with an error` };
        default:
            return { kind: 'failed', error: `the script that keeps the focus failed (exit ${code})` };
    }
}
/**
 * Starts a Windows Terminal launcher through the script that keeps the focus. Without Windows PowerShell to run it,
 * the launcher starts plainly: the tab then takes the focus, as before T2510, rather than not opening at all.
 */
export async function startKeepingFocus(processes, env, launcher) {
    const outcome = await processes.run(keepFocusRequest(launcher, env));
    return outcome.kind === 'exited' ? startOutcomeOf(launcher, outcome.code) : processes.start(launcher);
}
