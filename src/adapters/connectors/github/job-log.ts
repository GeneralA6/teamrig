import { plainLine } from '../../../plugin-api/index.ts';

/** Lines of a failed step's log a session is shown: its last ones, where the error is. */
export const EXCERPT_LINES = 20;

/** Characters of one log line kept: a line past it is cut, as a bundle or a dump can run on for pages. */
export const EXCERPT_WIDTH = 200;

/** The end of one failed job's log: the step that failed last, and its last lines; outside input, data only. */
export interface JobLogExcerpt {
  /** The step's name as the workflow gives it; undefined when the log had no line to read. */
  readonly step: string | undefined;
  readonly lines: readonly string[];
}

/** A terminal colour or cursor sequence (CSI), which a CI log is full of: dropped, as it says nothing to a reader. */
const ESCAPE_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** The time Actions writes at the head of each log line, which a reader of the excerpt does not need. */
const LINE_TIME = /^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;

/**
 * The excerpt of what `gh run view --job <id> --log-failed` printed: each line is `<job>\t<step>\t<time> <text>`, the
 * failed steps' lines in order. The step is that of the last line, and the lines are its last EXCERPT_LINES, each on
 * one plain line (no escape sequence, control or format character), `redact`ed whole before it is cut to
 * EXCERPT_WIDTH, so a cut never leaves part of a secret the redactor would no longer know.
 */
export function failedLogExcerpt(stdout: string, redact: (text: string) => string): JobLogExcerpt {
  const rows = stdout.split(/\r?\n/).flatMap((line) => {
    const [, step, ...text] = line.split('\t');
    return step === undefined || text.length === 0 ? [] : [{ step, text: text.join(' ') }];
  });
  const last = rows.at(-1);
  if (last === undefined) {
    return { step: undefined, lines: [] };
  }
  const lines = rows
    .filter((row) => row.step === last.step)
    .slice(-EXCERPT_LINES)
    .map((row) => cut(redact(plainLine(row.text.replace(ESCAPE_SEQUENCE, '').replace(LINE_TIME, '')))));
  return { step: cut(redact(plainLine(last.step))), lines };
}

/** `text` cut to EXCERPT_WIDTH characters, marked with an ellipsis when it was longer. */
function cut(text: string): string {
  return text.length <= EXCERPT_WIDTH ? text : `${text.slice(0, EXCERPT_WIDTH - 1)}…`;
}
