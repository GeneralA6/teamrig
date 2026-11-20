import {
  HOOK_EVENTS,
  isRecord,
  recordField,
  stringField,
  type HookBridge,
  type HookEvent,
  type HookEventName,
  type HookHelper,
  type HookReply,
  type HookVerdict,
  type JsonRecord,
  type ToolCall,
  type ToolCallShape,
} from '../../../plugin-api/index.ts';

/** Claude Code's name for each moment teamrig knows: the `hook_event_name` of its hook input and of a reply. */
const HOST_NAMES: Readonly<Record<HookEventName, string>> = {
  'session-start': 'SessionStart',
  'session-end': 'SessionEnd',
  prompt: 'UserPromptSubmit',
  'tool-start': 'PreToolUse',
  'permission-prompt': 'PermissionRequest',
  'tool-end': 'PostToolUse',
  'tool-failed': 'PostToolUseFailure',
  stop: 'Stop',
  'stop-failed': 'StopFailure',
  'helper-start': 'SubagentStart',
  'helper-stop': 'SubagentStop',
  'compact-start': 'PreCompact',
  'compact-end': 'PostCompact',
  'form-start': 'Elicitation',
  'form-end': 'ElicitationResult',
};

/** A Claude Code session id, as hook stdin carries it: any other text is no session. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The events whose reply Claude Code reads a top-level `decision: "block"` from. */
const BLOCKED_AT_TOP: ReadonlySet<HookEventName> = new Set<HookEventName>(['prompt', 'tool-end', 'stop', 'helper-stop', 'compact-start']);

/** The events whose `hookSpecificOutput` carries `additionalContext` to the model. */
const TAKES_CONTEXT: ReadonlySet<HookEventName> = new Set<HookEventName>(['session-start', 'prompt', 'tool-start', 'tool-end', 'tool-failed', 'helper-start']);

function eventNameOf(hostName: string | undefined): HookEventName | 'other' {
  return HOOK_EVENTS.find((name) => HOST_NAMES[name] === hostName) ?? 'other';
}

function sessionOf(payload: JsonRecord): string | undefined {
  const id = stringField(payload, 'session_id');
  return id !== undefined && SESSION_ID.test(id) ? id : undefined;
}

/** A hook that fires inside a helper carries `agent_id`; a session started as an agent carries its type alone. */
function helperOf(payload: JsonRecord): HookHelper | undefined {
  const helper = { id: stringField(payload, 'agent_id'), type: stringField(payload, 'agent_type'), transcript: stringField(payload, 'agent_transcript_path') };
  return helper.id === undefined && helper.type === undefined && helper.transcript === undefined ? undefined : helper;
}

function callOf(payload: JsonRecord, shape: ToolCallShape): ToolCall | undefined {
  const tool = stringField(payload, 'tool_name');
  if (tool === undefined) {
    return undefined;
  }
  const id = stringField(payload, 'tool_use_id');
  return {
    ...shape.normalize(tool, recordField(payload, 'tool_input') ?? {}),
    ...(id === undefined ? {} : { id }),
    ...(Object.hasOwn(payload, 'tool_response') ? { response: payload['tool_response'] } : {}),
  };
}

function eventOf(payload: JsonRecord, shape: ToolCallShape): HookEvent {
  const hostName = stringField(payload, 'hook_event_name');
  const name = eventNameOf(hostName);
  return {
    name,
    hostName,
    session: sessionOf(payload),
    cwd: stringField(payload, 'cwd'),
    transcript: stringField(payload, 'transcript_path'),
    helper: helperOf(payload),
    call: callOf(payload, shape),
    prompt: stringField(payload, 'prompt'),
    lastReply: stringField(payload, 'last_assistant_message'),
    stopActive: payload['stop_hook_active'] === true,
    source: stringField(payload, 'source'),
    trigger: stringField(payload, 'trigger'),
    model: stringField(payload, 'model'),
    // A form with no text of its own is named by the MCP server that asks.
    message: stringField(payload, 'message') ?? (name === 'form-start' ? stringField(payload, 'mcp_server_name') : undefined),
    error: stringField(payload, 'error'),
  };
}

function parsed(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** The sequence a terminal reads as "set this tab's title", which Claude Code writes for a hook's `terminalSequence`. */
function tabTitleSequence(title: string): string {
  return `\u001b]0;${title}\u0007`;
}

/** A verdict on a tool call, where Claude Code reads it: its permission fields before the call, its decision on the prompt. */
function permissionOf(on: HookEventName, verdict: HookVerdict | undefined): JsonRecord {
  if (verdict === undefined) {
    return {};
  }
  if (on === 'tool-start') {
    return verdict.kind === 'allow'
      ? { permissionDecision: 'allow', ...(verdict.reason === undefined ? {} : { permissionDecisionReason: verdict.reason }) }
      : { permissionDecision: 'deny', permissionDecisionReason: verdict.reason };
  }
  if (on === 'permission-prompt') {
    return { decision: verdict.kind === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: verdict.reason } };
  }
  return {};
}

/** The `hookSpecificOutput` of a reply, less its event name; its keys in the one order Claude Code's docs give them. */
function specificOf(on: HookEventName, reply: HookReply): JsonRecord {
  const { verdict } = reply;
  return {
    ...permissionOf(on, verdict),
    ...(on === 'tool-end' && reply.toolOutput !== undefined ? { updatedToolOutput: reply.toolOutput } : {}),
    ...(TAKES_CONTEXT.has(on) && reply.context !== undefined ? { additionalContext: reply.context } : {}),
    ...(on === 'prompt' && reply.sessionTitle !== undefined ? { sessionTitle: reply.sessionTitle } : {}),
    ...(on === 'prompt' && verdict?.kind === 'block' && verdict.hidePrompt === true ? { suppressOriginalPrompt: true } : {}),
  };
}

/** The top-level fields of a reply: a block where the event takes one, the human's notice, the tab's title. */
function topOf(on: HookEventName, reply: HookReply): JsonRecord {
  const { verdict } = reply;
  return {
    ...(verdict !== undefined && verdict.kind !== 'allow' && BLOCKED_AT_TOP.has(on) ? { decision: 'block', reason: verdict.reason } : {}),
    ...(reply.notice === undefined ? {} : { systemMessage: reply.notice }),
    ...(reply.tabTitle === undefined ? {} : { terminalSequence: tabTitleSequence(reply.tabTitle) }),
  };
}

/** Claude Code adds a prompt hook's plain standard output to the model's context, so context alone needs no JSON. */
function isPlainContext(on: HookEventName, reply: HookReply): boolean {
  return on === 'prompt' && reply.context !== undefined && reply.verdict === undefined && reply.notice === undefined && reply.tabTitle === undefined && reply.sessionTitle === undefined;
}

function replyText(on: HookEventName, reply: HookReply): string {
  if (isPlainContext(on, reply)) {
    return reply.context ?? '';
  }
  const top = topOf(on, reply);
  const specific = specificOf(on, reply);
  const output = Object.keys(specific).length === 0 ? top : { ...top, hookSpecificOutput: { hookEventName: HOST_NAMES[on], ...specific } };
  return Object.keys(output).length === 0 ? '' : JSON.stringify(output);
}

/**
 * The hook port of Claude Code: its hook input read into the event the core knows, and the core's reply written as
 * the JSON Claude Code reads on a hook's standard output. A part of a reply the event has no field for is dropped.
 */
export function hookBridge(shape: ToolCallShape): HookBridge {
  return {
    parse: (raw) => {
      const payload = parsed(raw);
      return isRecord(payload) ? eventOf(payload, shape) : undefined;
    },
    reply: replyText,
    // A hook that exits with an error other than 2 is shown to the human and the moment goes on.
    failureRule: 'passes',
  };
}
