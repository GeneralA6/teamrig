import type { ConfigLoad } from '../config/load.ts';
import { Roster } from '../config/roster.ts';
import { isRecord, stringField } from '../core/guards.ts';
import { ENV } from '../core/home.ts';
import type { Rename } from '../names/rename.ts';
import { renderCorePack, renderSessionContext, type KeptRule, type RulesClock, type TeamRules } from '../rules/pack.ts';
import { unloadedContext } from './session-start.ts';

/** A Claude Code subagent (a helper) a hook runs in: its id, and its type when that is a plain name. */
export interface Helper {
  readonly agentId: string;
  readonly agentType: string | undefined;
}

/** An agent type safe to print in the context: a name such as `general-purpose` or `plugin:reviewer`. */
const AGENT_TYPE = /^[\w.:-]{1,80}$/;

/**
 * The helper a hook payload comes from. Claude Code puts `agent_id` and `agent_type` on the hooks that
 * run inside a helper (its SubagentStart, its tool calls, a compaction of its context) and on no hook of
 * the session itself, while `session_id` stays the session's. Undefined for a session's own hook.
 */
export function helperOf(payload: unknown): Helper | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const agentId = stringField(payload, 'agent_id');
  if (agentId === undefined || agentId === '') {
    return undefined;
  }
  const type = stringField(payload, 'agent_type');
  return { agentId, agentType: type !== undefined && AGENT_TYPE.test(type) ? type : undefined };
}

export interface HelperStartInput {
  readonly team: string;
  readonly load: ConfigLoad;
  /** The `rules.md` of each team above the session's, root first, then its own team's; those that exist. */
  readonly teamRules: readonly TeamRules[];
  /** The kept local rules [ruleConflicts] of each team above the session's, root first; its own team's are in `load`. */
  readonly keptRulesAbove: readonly KeptRule[];
  /** The team's rename log, so the helper learns its session's current name. */
  readonly renames: readonly Rename[];
  /** The helper's agent type, printed when Claude Code gave a plain name. */
  readonly agentType: string | undefined;
  /** The session that started the helper, found the way its own start finds it; undefined when unknown. */
  readonly session: string | undefined;
  /** Whether `$TEAMRIG_SESSION` holds `session`, so commands find it without `--session`. */
  readonly sessionInEnv: boolean;
  readonly platform: NodeJS.Platform;
  /** When the rules are read and the machine's zone, which name the queue cutoff on the team's clock. */
  readonly clock: RulesClock;
  /** The CLI name the rules tell the helper to run. */
  readonly command: string;
}

/**
 * Whose helper this is and what it leaves to that session. Never "You are the X session": the helper
 * would take the session's identity and set its tasks or message its peers.
 */
function helperLine(roster: Roster, input: HelperStartInput): string {
  const { command, agentType } = input;
  const kind = agentType === undefined ? 'a helper' : `a helper (\`${agentType}\`)`;
  const found = input.session === undefined ? undefined : roster.lookup(input.session);
  const known = found !== undefined && found.ok ? found.id : undefined;
  const parent = known === undefined ? 'a session' : `the \`${known}\` session`;
  const name = known === undefined ? '' : ` (name \`${roster.nameOf(known) ?? known}\`)`;
  // T1457 (T348's aim): the full findings land in the task's folder and the reply stays short, so a helper saves
  // its caller's context the tokens it was started to keep out.
  const duty =
    `The rules above bind you as they bind it, but your brief is your task: leave \`${command} start\`, task statuses, register entries, inbox lines and messages to it unless your brief asks for them.` +
    ` Save your full findings in the folder of the task you work on (\`${command} files T<id>\`; with no task, \`${command} files --notes\`) and return their path and what it needs.`;
  const pass = known === undefined || input.sessionInEnv ? '' : ` $${ENV.session} is not set here, so pass --session ${known} to any \`${command}\` command your brief asks for.`;
  return `You are ${kind} of ${parent} of team \`${input.team}\`${name}. ${duty}${pass}`;
}

/**
 * The context a helper starts with (a SubagentStart, or a compaction inside the helper): the team's core
 * rules and its rules.md, as its session gets them, then whose helper it is. Nothing only a session acts
 * on: no lead lines, live tasks, verify list, refresh, title or model notes. Without a usable config it says
 * why no rules are loaded, in one line.
 */
export function helperStartContext(input: HelperStartInput): string {
  const { load, command } = input;
  if (load.status !== 'loaded') {
    return unloadedContext(input.team, load, command);
  }
  const roster = new Roster(load.config, input.team, input.renames);
  const core = renderCorePack(load.config, command, input.platform, input.clock, input.keptRulesAbove);
  return renderSessionContext(`${core}\n\n${helperLine(roster, input)}`, input.teamRules, command);
}

/** The SubagentStart hook's stdout: Claude Code adds `additionalContext` to the helper's context. */
export function subagentStartOutput(context: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: context } });
}
