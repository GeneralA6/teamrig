import {
  isRecord,
  stringField,
  type AskCall,
  type JsonRecord,
  type ShellDialect,
  type TextChange,
  type TextReplacement,
  type ToolCall,
  type ToolCallShape,
} from '../../../plugin-api/index.ts';
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

/** Reads the change a file-writing tool's input makes to its file's text, undefined when it does not read as one. */
type ChangeReader = (input: JsonRecord) => TextChange | undefined;

/** The replacement an Edit, or one edit of a MultiEdit, makes. */
function replacementOf(input: JsonRecord): TextReplacement | undefined {
  const from = stringField(input, 'old_string');
  const to = stringField(input, 'new_string');
  return from === undefined || to === undefined ? undefined : { from, to, all: input['replace_all'] === true };
}

/** A Write leaves the text it carries, whatever the file held. */
const wholeText: ChangeReader = (input) => {
  const text = stringField(input, 'content');
  return text === undefined ? undefined : { kind: 'whole', text };
};

const oneReplacement: ChangeReader = (input) => {
  const one = replacementOf(input);
  return one === undefined ? undefined : { kind: 'replacements', replacements: [one] };
};

/** A MultiEdit's edits in order; one that does not read as a replacement leaves the whole change unknown. */
const eachReplacement: ChangeReader = (input) => {
  const edits: unknown = input['edits'];
  if (!Array.isArray(edits)) {
    return undefined;
  }
  const replacements = edits.flatMap((edit: unknown) => {
    const one = isRecord(edit) ? replacementOf(edit) : undefined;
    return one === undefined ? [] : [one];
  });
  return replacements.length === edits.length ? { kind: 'replacements', replacements } : undefined;
};

/** A NotebookEdit changes one cell's source, which says nothing of the file's text as a whole. */
const noTextChange: ChangeReader = () => undefined;

function edit(changeOf: ChangeReader): Reader {
  return (name, input) => {
    const edits = input['edits'];
    const records = [input, ...(Array.isArray(edits) ? edits.filter(isRecord) : [])];
    return {
      kind: 'edit',
      name,
      input,
      path: stringField(input, 'file_path') ?? stringField(input, 'notebook_path'),
      texts: records.flatMap((record) => WRITTEN_TEXT_KEYS.flatMap((key) => stringField(record, key) ?? [])),
      change: changeOf(input),
    };
  };
}

/** The first question an asking tool's input lists, as written; undefined when it lists none. */
function firstQuestionOf(input: JsonRecord): string | undefined {
  const questions: unknown = input['questions'];
  const first = Array.isArray(questions) ? questions.find(isRecord) : undefined;
  return first === undefined ? undefined : stringField(first, 'question');
}

/** A tool that stops the turn for the human: the question picker asks a question, plan mode's exit a yes to its plan. */
function ask(asks: AskCall['asks']): Reader {
  return (name, input) => ({ kind: 'ask', name, input, asks, question: firstQuestionOf(input) });
}

const schedule: Reader = (name, input) => ({ kind: 'schedule', name, input });

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
  Write: edit(wholeText),
  Edit: edit(oneReplacement),
  MultiEdit: edit(eachReplacement),
  NotebookEdit: edit(noTextChange),
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
  AskUserQuestion: ask('question'),
  ExitPlanMode: ask('plan'),
  CronCreate: schedule,
  ScheduleWakeup: schedule,
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
