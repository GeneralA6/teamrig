import type { ConfigLoad } from '../config/load.ts';
import { isRecord, stringField, type JsonRecord } from '../core/guards.ts';
import { KIT_NAME } from '../core/home.ts';
import type { Redaction, ToolOutputRedactor } from '../secret-guard/redactor.ts';
import { postToolUseReplace } from './post-tool-use.ts';

/**
 * The secret redactor (T1369 R7): after a tool runs, each secret its result holds is replaced before the model and the
 * transcript see it, and the model is told which kinds were found, never a value, and who rotates them.
 */

/** The tools whose result shapes the probe saw replaced (T1369); any other tool's result stays as it is until probed. */
const REDACTED_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'Read', 'Grep']);

/**
 * The result to redact: a probed tool's, and of a Read only a text file's, as an image's or a notebook's is not probed.
 * Only a result object: the replacement must keep its shape, and the probe saw no tool hand its result as text.
 */
export function redactableResultOf(payload: unknown): JsonRecord | undefined {
  const tool = isRecord(payload) ? stringField(payload, 'tool_name') : undefined;
  if (!isRecord(payload) || tool === undefined || !REDACTED_TOOLS.has(tool)) {
    return undefined;
  }
  const response = payload['tool_response'];
  return !isRecord(response) || (tool === 'Read' && stringField(response, 'type') !== 'text') ? undefined : response;
}

/** Who rotates a leaked secret: the team's security reviewer, else its lead; "the lead" when the config did not load. */
export function rotatorOf(load: ConfigLoad | undefined): string {
  return load?.status === 'loaded' ? (load.config.roles.securityReviewer ?? load.config.roles.lead) : 'the lead';
}

/** The line for the model: the kinds found, never a value, who rotates them, and whether part of the result went unscanned. */
export function redactedLine(redaction: Redaction, rotator: string): string {
  const line = `${KIT_NAME}: this result held a secret (${redaction.classes.join(', ')}); it was redacted before you saw it. Treat it as leaked: ask ${rotator} to rotate it (a register task), and do not print it again.`;
  return redaction.cut ? `${line} Part of the result was past the scan's cap and was not checked.` : line;
}

/** The PostToolUse output for a result that held a secret: the redacted result and the line; undefined for any other. */
export function secretRedactOutput(payload: unknown, redactor: ToolOutputRedactor, rotator: string): string | undefined {
  const response = redactableResultOf(payload);
  if (response === undefined) {
    return undefined;
  }
  const redaction = redactor.redact(response);
  return redaction.classes.length === 0 ? undefined : postToolUseReplace(redaction.response, redactedLine(redaction, rotator));
}
