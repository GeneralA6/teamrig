import type { JsonRecord } from '../../core/guards.ts';

/**
 * What the host's status input (the text it hands its status line at each redraw) tells of one session. A field the
 * input did not tell is undefined; only `cwd` is always a string, empty when the input named no folder.
 */
export interface StatusReading {
  /** The session's id as the host gave it, unchecked: the core decides whether it may name a file. */
  readonly sessionId: string | undefined;
  readonly cwd: string;
  readonly agentName: string | undefined;
  /** The model's name as the host shows it to a person. */
  readonly model: string | undefined;
  /** The effort level, on a host and a model that take one. */
  readonly effort: string | undefined;
  readonly costUsd: number | undefined;
  readonly contextUsedPct: number | undefined;
  readonly contextInputTokens: number | undefined;
}

/** A change to the host's settings, or none when they already read this way. */
export interface StatusLinePlan {
  /** The settings to write; undefined when nothing changes. */
  readonly settings: JsonRecord | undefined;
  /** The status line's command before the change and after it; undefined for no status line. */
  readonly before: string | undefined;
  readonly after: string | undefined;
}

/** A plan, or why the settings as they are cannot be changed: a problem the core words as a refusal. */
export type StatusLineAnswer = { readonly ok: true; readonly value: StatusLinePlan } | { readonly ok: false; readonly problem: string };

/**
 * The host's status line: the line it draws under a session from a command it runs, handing that command a status
 * input. The core's launcher becomes that command, and a status line the person already had keeps running and
 * shows as before. The core reads and writes the settings file; this port only says how its content changes, and
 * reads the status input.
 */
export interface StatusLine {
  /** The name of the setting a plan changes, as a person would look it up in the host's settings. */
  readonly setting: string;
  /** The reading of a status input; undefined when the text is not one. */
  parse(input: string): StatusReading | undefined;
  /** Makes the launcher at this path the status line, in front of the one already there. */
  install(settings: JsonRecord, launcher: string): StatusLineAnswer;
  /** Takes the launcher back out: the status line that was there before it returns, or none when there was none. */
  uninstall(settings: JsonRecord, launcher: string): StatusLineAnswer;
}
