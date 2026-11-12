import type { MeetingConfig, TerminalChoice } from '../config/types.ts';
import type { Env } from '../core/home.ts';
import { powerShellRequest } from '../core/powershell.ts';
import { candidatesOf, type OpenTabDeps } from '../open/open-tab.ts';
import type { HiddenRequest, StartOutcome } from '../open/processes.ts';
import { MEETING_LAPSE_MS, type Meeting } from './state.ts';

/**
 * The meeting's spotlight (T2517): while the owner's daily meeting is open, every screen is dimmed but the Windows
 * Terminal window holding the lead's tab. A hidden Windows PowerShell runs a borderless black overlay over the whole
 * virtual screen, click-through and never activated, with a hole cut where that window is; it follows the window as it
 * moves and lifts itself once the meeting file says the meeting ended, another one started, or it lapsed. Nothing is
 * typed into a terminal, and the tab's title, the meeting file's path and the times reach the script as variables,
 * never inside it.
 */

/** The variables the spotlight script reads its values from. */
export const SPOTLIGHT_VARS = {
  title: 'TEAMRIG_SPOTLIGHT_TITLE',
  meeting: 'TEAMRIG_SPOTLIGHT_MEETING',
  startedAt: 'TEAMRIG_SPOTLIGHT_STARTED',
  until: 'TEAMRIG_SPOTLIGHT_UNTIL',
  dim: 'TEAMRIG_SPOTLIGHT_DIM',
} as const;

/** How often the overlay follows the window, in ms: a moved window's hole catches up within a quarter second. */
const TICK_MS = 250;
/** Every this many ticks (2 s) the script reads the meeting file and looks the window up again if it closed. */
const CHECK_TICKS = 8;
/** A meeting file unreadable this many checks in a row lifts the spotlight: one read beside a write is no end. */
const UNREADABLE_CHECKS = 3;

/** The overlay's native calls and its form, compiled by Add-Type on each run; no package needed. */
const SPOTLIGHT_TYPES = [
  "  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'",
  'using System;',
  'using System.Drawing;',
  'using System.Runtime.InteropServices;',
  'using System.Windows.Forms;',
  'public static class TeamrigSpotlightNative {',
  '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
  '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);',
  '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);',
  '  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out RECT rect, int size);',
  '  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);',
  '  static bool perMonitor;',
  '  // Per-monitor aware (-4), the overlay and the window it frames are measured in the same pixels on every screen.',
  '  public static void BeDpiAware() {',
  '    try { perMonitor = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { perMonitor = false; }',
  '  }',
  "  // DWMWA_EXTENDED_FRAME_BOUNDS (9) leaves out the invisible resize border GetWindowRect counts, but only in physical",
  '  // pixels, which match the overlay only when this process is per-monitor aware.',
  '  public static Rectangle FrameOf(IntPtr window) {',
  '    RECT rect = new RECT();',
  '    bool framed = perMonitor && DwmGetWindowAttribute(window, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0;',
  '    if (!framed && !GetWindowRect(window, out rect)) { return Rectangle.Empty; }',
  '    return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);',
  '  }',
  '}',
  'public class TeamrigSpotlightForm : Form {',
  '  public TeamrigSpotlightForm(double dim) {',
  '    FormBorderStyle = FormBorderStyle.None;',
  '    ShowInTaskbar = false;',
  '    StartPosition = FormStartPosition.Manual;',
  '    BackColor = Color.Black;',
  '    Opacity = dim;',
  '    Bounds = SystemInformation.VirtualScreen;',
  '  }',
  '  protected override bool ShowWithoutActivation { get { return true; } }',
  '  // Layered, click-through, no taskbar button, never activated, above every window. TopMost stays unset: setting it',
  '  // activates the form, which would take the focus from the meeting.',
  '  protected override CreateParams CreateParams {',
  '    get { CreateParams created = base.CreateParams; created.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x8000000 | 0x8; return created; }',
  '  }',
  '  public void Frame(Rectangle hole) {',
  '    Rectangle screen = SystemInformation.VirtualScreen;',
  '    Bounds = screen;',
  '    Region dimmed = new Region(new Rectangle(0, 0, screen.Width, screen.Height));',
  '    hole.Offset(-screen.Left, -screen.Top);',
  '    dimmed.Exclude(hole);',
  '    Region before = Region;',
  '    Region = dimmed;',
  '    if (before != null) { before.Dispose(); }',
  '  }',
  '}',
  // A here-string ends only at the start of a line.
  "'@",
];

/**
 * Windows PowerShell 5.1: finds the Windows Terminal window with a tab whose name is the title or ends with a space and
 * the title (as focus.ts does), dims every screen but that window, and follows it; while no such window shows (closed,
 * minimized, not found), nothing is dimmed. It exits 0 once the meeting it was started for is no longer open, 1 with
 * the reason on stderr when it cannot run.
 */
export const WINDOWS_SPOTLIGHT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // Its first module load writes a progress record, which reaches a caller's stderr as CLIXML.
  "$ProgressPreference = 'SilentlyContinue'",
  'try {',
  '  Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes',
  ...SPOTLIGHT_TYPES,
  // Before the first window of this process, which UI Automation may make too.
  '  [TeamrigSpotlightNative]::BeDpiAware()',
  `  $title = $env:${SPOTLIGHT_VARS.title}`,
  `  $meetingFile = $env:${SPOTLIGHT_VARS.meeting}`,
  `  $startedAt = $env:${SPOTLIGHT_VARS.startedAt}`,
  `  $until = [long]$env:${SPOTLIGHT_VARS.until}`,
  `  $dim = [double]::Parse($env:${SPOTLIGHT_VARS.dim}, [Globalization.CultureInfo]::InvariantCulture)`,
  '  $element = [System.Windows.Automation.AutomationElement]',
  '  $scope = [System.Windows.Automation.TreeScope]',
  "  $terminalWindow = [System.Windows.Automation.PropertyCondition]::new($element::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')",
  '  $tabItem = [System.Windows.Automation.PropertyCondition]::new($element::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)',
  '  function Find-LeadWindow {',
  '    foreach ($window in $element::RootElement.FindAll($scope::Children, $terminalWindow)) {',
  '      foreach ($tab in $window.FindAll($scope::Descendants, $tabItem)) {',
  '        $name = $tab.Current.Name',
  "        if ($name -ceq $title -or $name.EndsWith(' ' + $title, [StringComparison]::Ordinal)) { return [IntPtr]$window.Current.NativeWindowHandle }",
  '      }',
  '    }',
  '    return [IntPtr]::Zero',
  '  }',
  // True while the meeting is open, false once it is not, nothing when its file cannot be read now.
  '  function Test-MeetingOpen {',
  '    if ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $until) { return $false }',
  '    if (-not (Test-Path -LiteralPath $meetingFile)) { return $false }',
  '    try { $meeting = Get-Content -LiteralPath $meetingFile -Raw | ConvertFrom-Json } catch { return }',
  '    return ($meeting.startedAt -ceq $startedAt) -and ($null -eq $meeting.endedAt)',
  '  }',
  '  $overlay = New-Object TeamrigSpotlightForm -ArgumentList $dim',
  '  $window = [IntPtr]::Zero',
  '  $framed = [System.Drawing.Rectangle]::Empty',
  '  $unreadable = 0',
  '  $tick = 0',
  '  while ($true) {',
  `    if ($tick % ${CHECK_TICKS} -eq 0) {`,
  '      $open = Test-MeetingOpen',
  '      if ($null -eq $open) { $unreadable++ } elseif (-not $open) { exit 0 } else { $unreadable = 0 }',
  `      if ($unreadable -ge ${UNREADABLE_CHECKS}) { exit 0 }`,
  '      if (-not [TeamrigSpotlightNative]::IsWindow($window)) { $window = Find-LeadWindow }',
  '    }',
  '    $hole = [System.Drawing.Rectangle]::Empty',
  '    if ([TeamrigSpotlightNative]::IsWindowVisible($window) -and -not [TeamrigSpotlightNative]::IsIconic($window)) { $hole = [TeamrigSpotlightNative]::FrameOf($window) }',
  '    if ($hole.IsEmpty) {',
  '      if ($overlay.Visible) { $overlay.Hide() }',
  '    } else {',
  '      if ($hole -ne $framed) { $overlay.Frame($hole); $framed = $hole }',
  '      if (-not $overlay.Visible) { $overlay.Show() }',
  '    }',
  '    [System.Windows.Forms.Application]::DoEvents()',
  `    Start-Sleep -Milliseconds ${TICK_MS}`,
  '    $tick++',
  '  }',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
].join('\n');

/** What the spotlight of one meeting needs: the lead's tab title, the meeting file and the meeting it opened. */
export interface SpotlightTarget {
  readonly title: string;
  readonly meetingFile: string;
  readonly meeting: Meeting;
  readonly dim: number;
  /** The file its errors are appended to. */
  readonly log: string;
}

/** The hidden program that spotlights the window of `target.title` until the meeting is no longer open. */
export function spotlightRequest(target: SpotlightTarget, env: Env, cwd: string): HiddenRequest {
  const { program, args } = powerShellRequest(WINDOWS_SPOTLIGHT_SCRIPT);
  const until = Date.parse(target.meeting.startedAt) + MEETING_LAPSE_MS;
  return {
    command: program,
    args,
    cwd,
    log: target.log,
    env: {
      ...env,
      [SPOTLIGHT_VARS.title]: target.title,
      [SPOTLIGHT_VARS.meeting]: target.meetingFile,
      [SPOTLIGHT_VARS.startedAt]: target.meeting.startedAt,
      [SPOTLIGHT_VARS.until]: String(until),
      [SPOTLIGHT_VARS.dim]: String(target.dim),
    },
  };
}

/** How starting the spotlight went: off by config, not possible here, or the hidden program's start. */
export type SpotlightOutcome =
  | { readonly kind: 'off' }
  | { readonly kind: 'unsupported'; readonly why: string }
  | { readonly kind: 'start'; readonly outcome: StartOutcome };

/**
 * Starts the spotlight when the team turned it on and the lead's tab can be found: Windows, with Windows Terminal among
 * the terminals the team's `open.terminal` tries. Never waits for the overlay to show.
 */
export async function startSpotlight(
  deps: OpenTabDeps,
  config: MeetingConfig['spotlight'],
  terminal: TerminalChoice,
  target: Omit<SpotlightTarget, 'dim'>,
  cwd: string,
): Promise<SpotlightOutcome> {
  if (!config.enabled) {
    return { kind: 'off' };
  }
  if (deps.platform !== 'win32') {
    return { kind: 'unsupported', why: `it needs Windows, and this is ${deps.platform}` };
  }
  if (!candidatesOf(terminal, deps).includes('windows-terminal')) {
    return { kind: 'unsupported', why: `it needs Windows Terminal, and open.terminal is ${terminal}` };
  }
  return { kind: 'start', outcome: await deps.processes.startHidden(spotlightRequest({ ...target, dim: config.dim }, deps.env, cwd)) };
}

/** What `meeting start` prints of the spotlight; nothing when the team keeps it off. */
export function spotlightLine(outcome: SpotlightOutcome, target: Omit<SpotlightTarget, 'dim'>, dim: number): string | undefined {
  switch (outcome.kind) {
    case 'off':
      return undefined;
    case 'unsupported':
      return `NOT SPOTLIT: ${outcome.why}`;
    case 'start':
      switch (outcome.outcome.kind) {
        case 'started':
          return `SPOTLIGHT every screen dimmed (${dim}) but the window of ${target.title}, until the meeting ends; its errors go to ${target.log}`;
        case 'missing':
          return 'NOT SPOTLIT: Windows PowerShell is not installed';
        case 'failed':
          return `NOT SPOTLIT: ${outcome.outcome.error}`;
      }
  }
}
