import {
  isRecord,
  stringField,
  type JsonRecord,
  type TextReplacement,
  type ToolCall,
  type ToolCallShape,
} from '../../../plugin-api/index.ts';

/** Reads one Antigravity tool's arguments into the call the core knows. */
type Reader = (name: string, input: JsonRecord, platform: NodeJS.Platform) => ToolCall;

function shell(name: string, input: JsonRecord, platform: NodeJS.Platform): ToolCall {
  const command = stringField(input, 'CommandLine');
  const dialect = platform === 'win32' ? 'powershell' : 'bash';
  return { kind: 'shell', name, input, dialect, command, readings: command === undefined ? [] : [command] };
}

function writeFile(name: string, input: JsonRecord): ToolCall {
  const text = stringField(input, 'Content');
  return {
    kind: 'edit',
    name,
    input,
    path: stringField(input, 'Path'),
    texts: text === undefined ? [] : [text],
    change: text === undefined ? undefined : { kind: 'whole', text },
  };
}

function editFile(name: string, input: JsonRecord): ToolCall {
  const from = stringField(input, 'Target');
  const to = stringField(input, 'Replacement');
  const replacement: TextReplacement | undefined = from === undefined || to === undefined ? undefined : { from, to, all: true };
  return {
    kind: 'edit',
    name,
    input,
    path: stringField(input, 'Path'),
    texts: to === undefined ? [] : [to],
    change: replacement === undefined ? undefined : { kind: 'replacements', replacements: [replacement] },
  };
}

function firstQuestionOf(input: JsonRecord): string | undefined {
  const questions: unknown = input['questions'];
  const first = Array.isArray(questions) ? questions.find(isRecord) : undefined;
  return first === undefined ? undefined : stringField(first, 'question');
}

const READERS: Readonly<Record<string, Reader>> = {
  run_command: shell,
  read_file: (name, input) => ({ kind: 'read', name, input, path: stringField(input, 'Path') }),
  write_file: writeFile,
  edit_file: editFile,
  grep_search: (name, input) => ({
    kind: 'search',
    name,
    input,
    path: stringField(input, 'SearchPath'),
    glob: undefined,
    showsContent: true,
  }),
  find_by_name: (name, input) => ({
    kind: 'search',
    name,
    input,
    path: stringField(input, 'SearchDirectory'),
    glob: stringField(input, 'Pattern'),
    showsContent: false,
  }),
  list_dir: (name, input) => ({
    kind: 'search',
    name,
    input,
    path: stringField(input, 'DirectoryPath'),
    glob: undefined,
    showsContent: false,
  }),
  read_url_content: (name, input) => ({ kind: 'web', name, input, url: stringField(input, 'Url') }),
  search_web: (name, input) => ({ kind: 'web', name, input, url: stringField(input, 'query') }),
  invoke_subagent: (name, input) => ({ kind: 'helper', name, input, type: stringField(input, 'TypeName') }),
  swarm: (name, input) => ({ kind: 'helper', name, input, type: stringField(input, 'action') }),
  send_message: (name, input) => ({
    kind: 'message',
    name,
    input,
    to: stringField(input, 'Recipient')?.trim() || undefined,
    text: stringField(input, 'Message'),
  }),
  ask_question: (name, input) => ({ kind: 'ask', name, input, asks: 'question', question: firstQuestionOf(input) }),
  schedule: (name, input) => ({ kind: 'schedule', name, input }),
};

/** The tool-call port of Antigravity on `platform`. */
export function toolCallShape(platform: NodeJS.Platform): ToolCallShape {
  return {
    normalize: (name, input) => {
      const reader = Object.hasOwn(READERS, name) ? READERS[name] : undefined;
      return reader === undefined ? { kind: 'other', name, input } : reader(name, input, platform);
    },
  };
}
