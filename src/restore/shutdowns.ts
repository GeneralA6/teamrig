import { powerShellRequest } from '../core/powershell.ts';
import type { ProgramRunner } from '../github/credentials.ts';

/** When the machine's last clean shutdown ran, which tells a tab the shutdown closed from one closed at another time. */
export interface ShutdownLog {
  /** Undefined when it is not known, or the machine went down without one (power loss, a crash). */
  lastShutdown(): Promise<ShutdownWindow | undefined>;
}

/** The span of a clean shutdown: from the moment it was started to the moment the event log stopped. */
export interface ShutdownWindow {
  readonly start: number;
  readonly end: number;
}

/** The Windows System log events that tell how the machine last went down. */
export const SHUTDOWN_EVENTS = {
  /** A program or person started a shutdown or restart (Windows Update, the Start menu). */
  initiated: 1074,
  /** The event log service stopped: the last step of a clean shutdown. */
  eventLogStopped: 6006,
  /** The previous shutdown was unexpected. */
  unexpected: 6008,
  /** The machine rebooted without shutting down cleanly (Kernel-Power). */
  powerLost: 41,
} as const;

/** The longest a clean shutdown runs: how long before the event log stopped the shutdown that stopped it may have started. */
export const CLEAN_SHUTDOWN_LOOKBACK_MS = 2 * 60 * 60_000;
export const SHUTDOWN_QUERY_TIMEOUT_MS = 30_000;

export interface SystemEvent {
  readonly id: number;
  readonly at: number;
}

/**
 * The last shutdown, from the newest events: an unexpected end or a power loss has none. A stopped event log ends
 * it, and the started shutdown before it, within CLEAN_SHUTDOWN_LOOKBACK_MS, starts it, else the stop itself. A
 * started shutdown with no stop after it (one still running, or called off) starts it and ends
 * CLEAN_SHUTDOWN_LOOKBACK_MS later, the longest one runs.
 */
export function pickShutdown(events: readonly SystemEvent[]): ShutdownWindow | undefined {
  const sorted = [...events].sort((a, b) => b.at - a.at);
  const newest = sorted[0];
  switch (newest?.id) {
    case SHUTDOWN_EVENTS.initiated:
      return { start: newest.at, end: newest.at + CLEAN_SHUTDOWN_LOOKBACK_MS };
    case SHUTDOWN_EVENTS.eventLogStopped: {
      const started = sorted.find((event) => event.id === SHUTDOWN_EVENTS.initiated && event.at <= newest.at && newest.at - event.at <= CLEAN_SHUTDOWN_LOOKBACK_MS);
      return { start: started?.at ?? newest.at, end: newest.at };
    }
    default:
      return undefined;
  }
}

const IDS = Object.values(SHUTDOWN_EVENTS).join(',');

/** The PowerShell that prints the newest shutdown events, one `<id> <ISO instant>` line each. */
export const WINDOWS_SHUTDOWN_SCRIPT =
  `Get-WinEvent -FilterHashtable @{LogName='System'; Id=${IDS}} -MaxEvents 8 -ErrorAction SilentlyContinue | ` +
  `ForEach-Object { '{0} {1}' -f $_.Id, $_.TimeCreated.ToUniversalTime().ToString('o') }`;

const EVENT_LINE = /^(\d+) (\S+)$/;

/** The events in the script's output; a line of any other shape is skipped. */
export function parseWindowsEvents(stdout: string): readonly SystemEvent[] {
  const events: SystemEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = EVENT_LINE.exec(line.trim());
    const at = match?.[2] === undefined ? Number.NaN : Date.parse(match[2]);
    if (match?.[1] !== undefined && !Number.isNaN(at)) {
      events.push({ id: Number(match[1]), at });
    }
  }
  return events;
}

/**
 * The system's shutdown log. Only Windows records when a shutdown began; elsewhere it is unknown, so the restore
 * reopens only sessions that never recorded an end. A query that fails or times out also leaves it unknown.
 */
export function systemShutdownLog(platform: NodeJS.Platform, run: ProgramRunner): ShutdownLog {
  return {
    async lastShutdown() {
      if (platform !== 'win32') {
        return undefined;
      }
      try {
        const result = await run(powerShellRequest(WINDOWS_SHUTDOWN_SCRIPT));
        return result.end.kind === 'exited' && result.end.code === 0 ? pickShutdown(parseWindowsEvents(result.stdout)) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
