import type { ConfigLoad } from '../config/load.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import type { Redaction } from '../secret-guard/redactor.ts';

/**
 * The secret redactor (T1369 R7): after a tool runs, each secret its result holds is replaced before the model and the
 * transcript see it, and the model is told which kinds were found, never a value, and who rotates them (R8: in which
 * register task).
 */

/** The tools whose result shapes the probe saw replaced (T1369); any other tool's result stays as it is until probed. */
const REDACTED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Read', 'Grep']);

/** A result the redactor scans: the hook payload it came in, the tool that gave it, and the result object. */
export interface RedactableResult {
  readonly payload: JsonRecord;
  readonly tool: string;
  readonly response: JsonRecord;
}

/**
 * The result to redact: a probed tool's, and of a Read only a text file's, as an image's or a notebook's is not probed.
 * Only a result object: the replacement must keep its shape, and the probe saw no tool hand its result as text.
 */
export function redactableResultOf(payload: unknown): RedactableResult | undefined {
  const tool = isRecord(payload) ? stringField(payload, 'tool_name') : undefined;
  if (!isRecord(payload) || tool === undefined || !REDACTED_TOOLS.has(tool)) {
    return undefined;
  }
  const response = payload['tool_response'];
  return !isRecord(response) || (tool === 'Read' && stringField(response, 'type') !== 'text') ? undefined : { payload, tool, response };
}

/** What became of one kind's rotation (T1369 R8): the task that has it rotated, or why none was filed. */
export type Rotation = { readonly kind: string; readonly task: string } | { readonly kind: string; readonly problem: string };

/** Who rotates a leaked secret: the team's security reviewer, else its lead; "the lead" when the config did not load. */
export function rotatorOf(load: ConfigLoad | undefined): string {
  return load?.status === 'loaded' ? (load.config.roles.securityReviewer ?? load.config.roles.lead) : 'the lead';
}

const distinct = (values: readonly string[]): string => [...new Set(values)].join(', ');

/**
 * What the model does about the leak: nothing more where every kind has its rotation task, which it is told; else it
 * asks the rotator for one, told why filing it failed.
 */
export function rotationText(rotator: string, rotations: readonly Rotation[]): string {
  const tasks = rotations.flatMap((rotation) => ('task' in rotation ? [rotation.task] : []));
  const problems = rotations.flatMap((rotation) => ('problem' in rotation ? [rotation.problem] : []));
  if (problems.length === 0) {
    return `${rotator} rotates it in ${distinct(tasks)}.`;
  }
  const ask = `ask ${rotator} to rotate ${tasks.length === 0 ? 'it' : 'the rest'} with a register task (filing one failed: ${distinct(problems)}).`;
  return tasks.length === 0 ? ask : `${rotator} rotates it in ${distinct(tasks)}; ${ask}`;
}

/** The line for the model: the kinds found, never a value, what becomes of them, and whether part of the result went unscanned. */
export function redactedLine(redaction: Pick<Redaction, 'classes' | 'cut'>, rotation: string): string {
  const line = `${KIT_NAME}: this result held a secret (${redaction.classes.join(', ')}); it was redacted before you saw it. Treat it as leaked: ${rotation} Do not print it again.`;
  return redaction.cut ? `${line} Part of the result was past the scan's cap and was not checked.` : line;
}
