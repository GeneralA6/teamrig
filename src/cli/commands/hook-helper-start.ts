import { Roster } from '../../config/roster.ts';
import { errorMessage } from '../../core/guards.ts';
import { KIT_NAME } from '../../core/home.ts';
import { helperOf, helperStartContext, subagentStartOutput, type HelperStartInput } from '../../hooks/helper-start.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit, rulesClockOf, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { keptRulesAboveOf, readTeamRules } from '../team-rules.ts';
import { loadTree } from '../tree.ts';
import { envSession, parseJson, sessionTeam, startSessionOf } from './hook-input.ts';

/**
 * A helper's start context, read-only: the rename log, the rules.md of its team and of each team above
 * it, and the session that started it, found as that session's own start finds it (`$TEAMRIG_SESSION`, else the area its Claude Code
 * session read its inbox as: a helper's hooks carry the session's id). It binds no tab, renames nothing
 * and starts no refresh: those belong to the session.
 */
export async function helperContextOf(runtime: CliRuntime, kit: Kit, payload: unknown, agentType: string | undefined): Promise<string> {
  const base = { team: kit.paths.team, agentType, platform: runtime.platform, clock: rulesClockOf(runtime), command: KIT_NAME };
  const { load } = kit;
  if (load.status !== 'loaded') {
    return helperStartContext({ ...base, load, teamRules: [], keptRulesAbove: [], renames: [], session: undefined, sessionInEnv: false });
  }
  const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
  const roster = new Roster(load.config, kit.paths.team, renames);
  const fromEnv = envSession(runtime);
  const kitTree = await loadTree(runtime);
  const input: HelperStartInput = {
    ...base,
    load,
    teamRules: await readTeamRules(runtime, kit, kitTree),
    keptRulesAbove: keptRulesAboveOf(kit, kitTree),
    renames,
    session: fromEnv ?? (await startSessionOf(runtime, kit, roster, payload)),
    sessionInEnv: fromEnv !== undefined,
  };
  return helperStartContext(input);
}

/**
 * SubagentStart: gives a helper the team's rules in a helper's words (hooks/helper-start.ts), since Claude
 * Code starts a helper with the CLAUDE.md files but not the session's SessionStart context. Outside a team's
 * projects it prints nothing; it never refuses (a refusal would fail the helper's launch), and a failed read
 * says why the rules are missing instead of leaving the helper without a word.
 */
export async function subagentStart(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const payload = parseJson(await runtime.readStdin());
  const found = await sessionTeam(payload, runtime);
  switch (found.kind) {
    case 'none':
      return EXIT.ok;
    case 'broken':
      runtime.out.stdout(subagentStartOutput(`${KIT_NAME}: no team, so no team rules: ${found.from} ${found.problem}`));
      return EXIT.ok;
    case 'team':
      break;
  }
  const context = await openKit(runtime, found.team)
    .then((kit) => helperContextOf(runtime, kit, payload, helperOf(payload)?.agentType))
    .catch((error: unknown) => `${KIT_NAME} could not load the rules of team ${found.team}: ${errorMessage(error)}`);
  runtime.out.stdout(subagentStartOutput(context));
  return EXIT.ok;
}
