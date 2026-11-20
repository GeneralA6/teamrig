import { isRecord, stringField, type JsonRecord, type ShellDialect, type ToolCall, type ToolCallShape } from '../../../plugin-api/index.ts';
import { bashReadings } from './bash-readings.ts';

/** Reads one tool's input into the call the core knows. */
type Reader = (name: string, input: JsonRecord, platform: NodeJS.Platform) => ToolCall;

/** Only the Bash tool's line passes through the Windows command line that rewrites it: PowerShell's runs as written. */
function shell(dialect: ShellDialect): Reader {
  return (name, input, platform) => {
    const command = stringField(input, 'command');
    const readings = command === undefined ? [] : dialect === 'bash' ? bashReadings(command, platform) : [command];
    return { kind: 'shell', name, input, dialect, command, readings };
  };
}

/** The keys under which a file-writing tool carries the text it writes: Write, Edit and each MultiEdit edit, NotebookEdit. */
const WRITTEN_TEXT_KEYS = ['content', 'new_string', 'new_source'] as const;

const edit: Reader = (name, input) => {
  const edits = input['edits'];
  const records = [input, ...(Array.isArray(edits) ? edits.filter(isRecord) : [])];
  return {
    kind: 'edit',
    name,
    input,
    path: stringField(input, 'file_path') ?? stringField(input, 'notebook_path'),
    texts: records.flatMap((record) => WRITTEN_TEXT_KEYS.flatMap((key) => stringField(record, key) ?? [])),
  };
};

function plain(kind: 'ask' | 'schedule'): Reader {
  return (name, input) => ({ kind, name, input });
}

const helper: Reader = (name, input) => ({ kind: 'helper', name, input, type: stringField(input, 'subagent_type') });

const web: Reader = (name, input) => ({ kind: 'web', name, input, url: stringField(input, 'url') });

/**
 * The receiver a SendMessage call names. A name may carry a ` [ref]` that picks one of two sessions sharing it: the
 * mark is Claude Code's, so the receiver is the name without it; undefined for a call naming none.
 */
function receiverOf(input: JsonRecord): string | undefined {
  const to = stringField(input, 'to')?.replace(/\s*\[[^\]]*\]$/, '').trim();
  return to === '' ? undefined : to;
}

/** Claude Code's tools by name. One it adds later, and every MCP tool, is `other` until a row here names its kind. */
const READERS: Readonly<Record<string, Reader>> = {
  Bash: shell('bash'),
  PowerShell: shell('powershell'),
  Read: (name, input) => ({ kind: 'read', name, input, path: stringField(input, 'file_path') }),
  Write: edit,
  Edit: edit,
  MultiEdit: edit,
  NotebookEdit: edit,
  Grep: (name, input) => ({
    kind: 'search',
    name,
    input,
    path: stringField(input, 'path'),
    glob: stringField(input, 'glob'),
    showsContent: stringField(input, 'output_mode') === 'content',
  }),
  Glob: (name, input) => ({ kind: 'search', name, input, path: stringField(input, 'path'), glob: stringField(input, 'pattern'), showsContent: false }),
  WebFetch: web,
  WebSearch: web,
  Agent: helper,
  Task: helper,
  Skill: (name, input) => ({ kind: 'skill', name, input, skill: stringField(input, 'skill') }),
  AskUserQuestion: plain('ask'),
  ExitPlanMode: plain('ask'),
  CronCreate: plain('schedule'),
  ScheduleWakeup: plain('schedule'),
  SendMessage: (name, input) => ({ kind: 'message', name, input, to: receiverOf(input), text: stringField(input, 'message') }),
};

/** The tool-call port of Claude Code on `platform`, which decides what a Bash command's readings are. */
export function toolCallShape(platform: NodeJS.Platform): ToolCallShape {
  return {
    normalize: (name, input) => {
      const reader = Object.hasOwn(READERS, name) ? READERS[name] : undefined;
      return reader === undefined ? { kind: 'other', name, input } : reader(name, input, platform);
    },
  };
}
