/**
 * The input Antigravity CLI (`agy`) hands a command hook, checked against the shape its hooks page gives its event.
 *
 * agy writes one camelCase JSON object to a hook's stdin. Unlike Codex and Claude Code, that object does not name its
 * event, so the hook's own command line carries the event and the caller passes it in. The fields per event come from
 * `https://antigravity.google/docs/hooks/` as read 2026-11-20 for agy 1.5.12, with two live reports by others: a
 * PostToolUse seen with a null `toolCall`, and a Stop reason outside the page's list. Nothing here is read from a
 * running agy yet. A hook that acts on an input it misread could pass a call it should refuse, so an input missing a
 * field its event must carry, or carrying one of the wrong type, is refused with a reason. A field the page does not
 * name is reported and not refused: a newer agy may add one, and what to do about it is the caller's call.
 */

import { isAntigravityHookEvent, type AntigravityHookEvent } from './events.ts';

/** An input that fits its event's shape, with the fields the page does not name, or why it does not fit. */
export type HookInputCheck =
  | { readonly ok: true; readonly event: AntigravityHookEvent; readonly unknownKeys: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** What a field holds. A tool call is `{ name, args }` with a text name and an object of arguments. */
type FieldKind = 'string' | 'whole number' | 'boolean' | 'list of strings' | 'tool call' | 'tool call or null';

type Fields = Readonly<Record<string, FieldKind>>;

interface InputShape {
  readonly required: Fields;
  readonly optional: Fields;
}

/** Every event carries these. */
const COMMON: Fields = {
  conversationId: 'string',
  workspacePaths: 'list of strings',
  transcriptPath: 'string',
  artifactDirectoryPath: 'string',
  modelName: 'string',
};

/** Only newer builds send the prompt last typed; older ones left it to the transcript. */
const COMMON_OPTIONAL: Fields = { lastUserInput: 'string' };

const INVOCATION: Fields = { ...COMMON, invocationNum: 'whole number', initialNumSteps: 'whole number' };

const SHAPES: Readonly<Record<AntigravityHookEvent, InputShape>> = {
  SessionStart: { required: COMMON, optional: COMMON_OPTIONAL },
  // A guard cannot judge a call it cannot see, so a PreToolUse with no tool call is refused.
  PreToolUse: { required: { ...COMMON, toolCall: 'tool call', stepIdx: 'whole number' }, optional: COMMON_OPTIONAL },
  // One live log saw a null tool call after the call ran; nothing is decided there, so it is taken.
  PostToolUse: {
    required: { ...COMMON, toolCall: 'tool call or null', stepIdx: 'whole number', error: 'string' },
    optional: COMMON_OPTIONAL,
  },
  PreInvocation: { required: INVOCATION, optional: COMMON_OPTIONAL },
  PostInvocation: { required: INVOCATION, optional: COMMON_OPTIONAL },
  // The page lists model_stop, max_steps_exceeded and error as reasons, and a live log saw NO_TOOL_CALL, so any text.
  Stop: {
    required: { ...COMMON, executionNum: 'whole number', terminationReason: 'string', error: 'string', fullyIdle: 'boolean' },
    optional: COMMON_OPTIONAL,
  },
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolCall(value: unknown): boolean {
  return isRecord(value) && typeof value['name'] === 'string' && isRecord(value['args']);
}

function fits(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'whole number':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    case 'boolean':
      return typeof value === 'boolean';
    case 'list of strings':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'tool call':
      return isToolCall(value);
    case 'tool call or null':
      return value === null || isToolCall(value);
  }
}

function refuse(reason: string): HookInputCheck {
  return { ok: false, reason };
}

/** The first field of `fields` the input lacks (when it must be there) or holds with the wrong type. */
function faultIn(input: Readonly<Record<string, unknown>>, fields: Fields, required: boolean): string | undefined {
  for (const [key, kind] of Object.entries(fields)) {
    if (!Object.hasOwn(input, key)) {
      if (required) {
        return `has no ${key}`;
      }
      continue;
    }
    if (!fits(input[key], kind)) {
      return `holds a ${key} that is not a ${kind}`;
    }
  }
  return undefined;
}

/** Checks a hook's parsed stdin against the shape agy's hooks page gives `event`, the event its command line named. */
export function checkHookInput(event: string, payload: unknown): HookInputCheck {
  if (!isAntigravityHookEvent(event)) {
    return refuse(`${event} is not an event Antigravity CLI fires`);
  }
  if (!isRecord(payload)) {
    return refuse(`the ${event} hook input is not a JSON object`);
  }
  const shape = SHAPES[event];
  const fault = faultIn(payload, shape.required, true) ?? faultIn(payload, shape.optional, false);
  if (fault !== undefined) {
    return refuse(`the ${event} hook input ${fault}`);
  }
  const named = new Set([...Object.keys(shape.required), ...Object.keys(shape.optional)]);
  return { ok: true, event, unknownKeys: Object.keys(payload).filter((key) => !named.has(key)) };
}
