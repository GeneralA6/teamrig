import { Roster } from '../../config/roster.ts';
import { ENV, KIT_NAME } from '../../core/home.ts';
import { sessionStartContext } from '../../hooks/session-start.ts';
import { JsonlRenameLog } from '../../names/log.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { sessionRef } from '../inputs.ts';
import { findTeam, openKit, requireConfig, rulesClockOf, sessionIdOf } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { readTeamRules } from '../team-rules.ts';
import { loadTree } from '../tree.ts';

/**
 * `rules [--session <id|name>]`: the rules of the team and of each team above it, and who the session is, the same text the
 * SessionStart hook gives. A tab that set the team up started with no team, so it loads them with
 * this instead of a restart.
 */
export async function rules(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const { team } = await findTeam(runtime);
  const kit = await openKit(runtime, team);
  const config = requireConfig(kit, runtime, 'read');
  const { renames } = await new JsonlRenameLog(runtime.files, kit.paths.renames).read();
  const flag = args.flags.get('session');
  if (flag !== undefined) {
    sessionIdOf(new Roster(config, kit.paths.team, renames), sessionRef('--session', flag));
  }
  const fromEnv = runtime.env[ENV.session]?.trim();
  const inEnv = flag === undefined && fromEnv !== undefined && fromEnv !== '';
  const kitTree = await loadTree(runtime);
  const context = sessionStartContext({
    team,
    platform: runtime.platform,
    clock: rulesClockOf(runtime),
    load: kit.load,
    teamRules: await readTeamRules(runtime, kit, kitTree),
    renames,
    titleNote: undefined,
    refreshNote: undefined,
    liveTasksNote: undefined,
    modelNote: undefined,
    verifyNote: undefined,
    session: flag ?? (inEnv ? fromEnv : undefined),
    sessionInEnv: inEnv,
    tree: kitTree.tree.placeOf(team),
    command: KIT_NAME,
  });
  runtime.out.stdout(context);
  return EXIT.ok;
}
