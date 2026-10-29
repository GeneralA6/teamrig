/** Token counts of a fixture reply; any count left out is not written. */
export interface FixtureUsage {
  readonly input?: number;
  readonly cacheWrite?: number;
  readonly cacheWrite5m?: number;
  readonly cacheWrite1h?: number;
  readonly cacheRead?: number;
  readonly output?: number;
}

export interface FixtureTool {
  readonly id: string;
  readonly name: string;
  readonly command?: string;
  /** Written as the input's `file_path`. */
  readonly path?: string;
  /** Written as the input's `url`, as a `WebFetch` call has it. */
  readonly url?: string;
  /** Written as the input's `skill`, as a `Skill` call has it. */
  readonly skill?: string;
  /** Written as the input's `subagent_type`, as an `Agent` call has it. */
  readonly agent?: string;
  /** Written as the input's `run_in_background`. */
  readonly background?: boolean;
}

export interface FixtureReply {
  readonly id?: string;
  readonly requestId?: string;
  readonly at?: string;
  readonly sidechain?: boolean;
  readonly usage: FixtureUsage;
  readonly tools?: readonly FixtureTool[];
}

export interface FixtureResult {
  readonly id: string;
  readonly text: string;
  readonly isError?: boolean;
}

function definedEntries(entries: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));
}

function usageJson(usage: FixtureUsage): Record<string, unknown> {
  const split =
    usage.cacheWrite5m === undefined && usage.cacheWrite1h === undefined
      ? undefined
      : definedEntries({ ephemeral_5m_input_tokens: usage.cacheWrite5m, ephemeral_1h_input_tokens: usage.cacheWrite1h });
  return definedEntries({
    input_tokens: usage.input,
    cache_creation_input_tokens: usage.cacheWrite,
    cache_read_input_tokens: usage.cacheRead,
    output_tokens: usage.output,
    cache_creation: split,
  });
}

/** An assistant reply line the way Claude Code writes one, its timestamp near the end as in real transcripts. */
export function replyLine(reply: FixtureReply): string {
  const tools = (reply.tools ?? []).map((tool) => ({
    type: 'tool_use',
    id: tool.id,
    name: tool.name,
    input: definedEntries({
      command: tool.command,
      file_path: tool.path,
      url: tool.url,
      skill: tool.skill,
      subagent_type: tool.agent,
      run_in_background: tool.background,
    }),
  }));
  return JSON.stringify(
    definedEntries({
      parentUuid: null,
      isSidechain: reply.sidechain ?? false,
      type: 'assistant',
      message: definedEntries({ id: reply.id, role: 'assistant', content: tools, usage: usageJson(reply.usage) }),
      requestId: reply.requestId,
      timestamp: reply.at,
    }),
  );
}

/** A user line carrying tool results. */
export function resultsLine(at: string, results: readonly FixtureResult[], sidechain = false): string {
  const content = results.map((result) => ({ type: 'tool_result', tool_use_id: result.id, content: result.text, is_error: result.isError ?? false }));
  return JSON.stringify({ isSidechain: sidechain, type: 'user', message: { role: 'user', content }, timestamp: at });
}

/** A model line with text blocks, then a tool call for each of `toolIds`, under its own `uuid`. */
export function textLine(uuid: string, texts: readonly string[], toolIds: readonly string[] = []): string {
  const content = [...texts.map((text) => ({ type: 'text', text })), ...toolIds.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: {} }))];
  return JSON.stringify({ uuid, isSidechain: false, type: 'assistant', message: { role: 'assistant', content } });
}

/** A user prompt line. */
export function promptLine(at: string, text = 'go', sidechain = false): string {
  return JSON.stringify({ isSidechain: sidechain, type: 'user', message: { role: 'user', content: text }, timestamp: at });
}

/** A line the meter ignores: Claude Code's own note, here a turn's duration. */
export function systemLine(at: string): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 1_000, timestamp: at });
}

/** The summary Claude Code writes as a user line to resume a compacted session or helper. */
export function summaryLine(at: string, sidechain = false): string {
  return JSON.stringify({ isSidechain: sidechain, type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued.' }, timestamp: at });
}

/** Claude Code's marker where it compacted the session's context. */
export function compactLine(at: string): string {
  return JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: at });
}

/** A skill, agent type or tool as a listing names it, and its description. */
export interface FixtureListing {
  readonly name: string;
  readonly description: string;
}

/** The line a listing shows an entry by. */
function listingText(entry: FixtureListing): string {
  return `- ${entry.name}: ${entry.description}`;
}

function attachmentLine(attachment: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ parentUuid: null, isSidechain: false, attachment, type: 'attachment' });
}

/** Claude Code's skill listing: every skill when `initial`, else only the skills added. */
export function skillListingLine(skills: readonly FixtureListing[], initial = true): string {
  return attachmentLine({
    type: 'skill_listing',
    content: skills.map(listingText).join('\n'),
    skillCount: skills.length,
    isInitial: initial,
    names: skills.map((skill) => skill.name),
  });
}

export interface FixtureToolsDelta {
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
  /** Tools shown with their whole definition, here only a name and a description. */
  readonly surfaced?: readonly FixtureListing[];
}

/** The deferred tools Claude Code adds and removes; it lists a tool by its name. */
export function deferredToolsLine(delta: FixtureToolsDelta): string {
  const surfaced = delta.surfaced ?? [];
  return attachmentLine({
    type: 'deferred_tools_delta',
    addedNames: delta.added ?? [],
    addedLines: delta.added ?? [],
    removedNames: delta.removed ?? [],
    surfacedNames: surfaced.map((tool) => tool.name),
    surfacedDefinitions: surfaced.map((tool) => ({ name: tool.name, listing: tool.name, definition: { name: tool.name, description: tool.description } })),
  });
}

export interface FixtureAgentsDelta {
  readonly added?: readonly FixtureListing[];
  readonly builtIn?: readonly string[];
  readonly removed?: readonly string[];
  readonly initial?: boolean;
}

/** The agent types Claude Code lists for the Agent tool: every type when `initial`, else the changes. */
export function agentListingLine(delta: FixtureAgentsDelta): string {
  const added = delta.added ?? [];
  return attachmentLine({
    type: 'agent_listing_delta',
    addedTypes: added.map((agent) => agent.name),
    addedLines: added.map(listingText),
    builtInTypes: delta.builtIn ?? [],
    removedTypes: delta.removed ?? [],
    isInitial: delta.initial ?? true,
  });
}

/** MCP servers' instructions, one block per server added, and the servers removed. */
export function mcpInstructionsLine(added: readonly FixtureListing[], removed: readonly string[] = []): string {
  return attachmentLine({
    type: 'mcp_instructions_delta',
    addedNames: added.map((server) => server.name),
    addedBlocks: added.map((server) => server.description),
    removedNames: removed,
  });
}

/** Lines as a transcript file's text: each line ends in a line end. */
export function transcript(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join('');
}
