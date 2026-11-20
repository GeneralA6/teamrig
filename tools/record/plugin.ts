import { isRecord, recordField, type JsonRecord } from '../lib/guards.ts';

/** The placeholder Claude Code fills with the plugin's folder. */
const PLUGIN_ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}';
/** The recorder plugin's one script, which every hook runs. */
export const RECORDER_SCRIPT = 'record.cjs';
/** Seconds Claude Code waits for a recorder hook, which only appends a line. */
const HOOK_TIMEOUT_SECONDS = 15;

/** The events a parsed `hooks/hooks.json` wires, in its order; none when it is not a hooks manifest. */
export function eventsOf(manifest: unknown): string[] {
  const hooks = isRecord(manifest) ? recordField(manifest, 'hooks') : undefined;
  return hooks === undefined ? [] : Object.keys(hooks);
}

/**
 * The script every recorder hook runs: it appends its stdin, as Claude Code sent it, to `outFile` as one JSON string
 * per line. The whole input goes in one append, so two hooks that fire together never mix their lines.
 */
function recorderScript(outFile: string): string {
  return [
    "const { appendFileSync, readFileSync } = require('node:fs');",
    `appendFileSync(${JSON.stringify(outFile)}, JSON.stringify(readFileSync(0, 'utf8')) + '\\n');`,
    '',
  ].join('\n');
}

/**
 * The recorder plugin's files by their path in the plugin folder: one exec-form hook per event of `events`, with no
 * matcher, so every tool's call reaches it. A hook prints nothing and exits 0, so it changes nothing the session does.
 */
export function recorderPlugin(events: readonly string[], outFile: string): Readonly<Record<string, string>> {
  const hook = { type: 'command', command: 'node', args: [`${PLUGIN_ROOT_VAR}/${RECORDER_SCRIPT}`], timeout: HOOK_TIMEOUT_SECONDS };
  const hooks = Object.fromEntries(events.map((event) => [event, [{ hooks: [hook] }]]));
  return {
    '.claude-plugin/plugin.json': `${JSON.stringify({ name: 'teamrig-recorder', version: '0.0.0', description: 'Records each hook input' })}\n`,
    'hooks/hooks.json': `${JSON.stringify({ hooks }, null, 2)}\n`,
    [RECORDER_SCRIPT]: recorderScript(outFile),
  };
}

/**
 * The hook inputs the recorder script wrote, in firing order; a line that is not a JSON string holding a JSON object
 * is an error, as it means a hook input was lost or torn.
 */
export function recordedInputs(text: string): JsonRecord[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, index) => {
      const input: unknown = JSON.parse(line);
      const payload: unknown = typeof input === 'string' ? JSON.parse(input) : undefined;
      if (!isRecord(payload)) {
        throw new Error(`recorded hook input ${index + 1} is not a JSON object`);
      }
      return payload;
    });
}
