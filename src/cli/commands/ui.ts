import type { KitConfig } from '../../config/types.ts';
import { ID_PATTERN, ID_RULE } from '../../core/ids.ts';
import type { RunOutcome } from '../../open/processes.ts';
import { uiRequest } from '../../ui/start.ts';
import { noPositionals, UsageError, type ParsedArgs } from '../args.ts';
import { openKit, openTeamKit, requireConfig, rosterOf, sessionIdOf, type Kit } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/** The kit of the team `--team` names, else of the team found here. */
function kitOf(team: string | undefined, runtime: CliRuntime): Promise<Kit> {
  if (team === undefined) {
    return openTeamKit(runtime);
  }
  if (!ID_PATTERN.test(team)) {
    throw new UsageError(`--team ${team} is no team id: ${ID_RULE}`, 'ui');
  }
  return openKit(runtime, team);
}

/**
 * The UI's entry script: the one `ui.path` names, which must be a file. No released UI is pinned yet, so without the
 * key there is nothing to start.
 */
async function entryOf(config: KitConfig, runtime: CliRuntime): Promise<string> {
  const { path } = config.ui;
  if (path === undefined) {
    throw new RefusedError('no released UI is pinned in this teamrig yet; set ui.path in the team config to a UI entry script of your own build');
  }
  if ((await runtime.probe.kind(path)) !== 'file') {
    throw new RefusedError(`ui.path names ${path}, and no file is there; fix or remove ui.path in the team config`);
  }
  return path;
}

function uiExit(runtime: CliRuntime, node: string, result: RunOutcome): ExitCode {
  switch (result.kind) {
    case 'exited':
      if (result.code === 0) {
        return EXIT.ok;
      }
      runtime.out.stderr(`FAILED the UI exited with code ${result.code}`);
      return EXIT.failed;
    case 'missing':
      runtime.out.stderr(`FAILED ${node} is gone`);
      return EXIT.failed;
    case 'failed':
      runtime.out.stderr(`FAILED ${node}: ${result.error}`);
      return EXIT.failed;
  }
}

/**
 * `ui [--session <id|name>] [--team <team>]`: starts the dedicated UI in this terminal, its input and output on it,
 * and ends when the UI does. The UI is a program of its own that teamrig loads no code of: it runs under this CLI's
 * Node.js and is handed this CLI to call back (ui/start.ts).
 */
export async function ui(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const kit = await kitOf(args.flags.get('team'), runtime);
  const config = requireConfig(kit, runtime, 'read');
  const named = args.flags.get('session');
  const session = named === undefined ? undefined : sessionIdOf(await rosterOf(runtime, kit, config), named);
  const entry = await entryOf(config, runtime);
  const { node, script } = runtime.self;
  const request = uiRequest({ entry, node, script, team: kit.paths.team, cwd: runtime.cwd, env: runtime.env, ...(session === undefined ? {} : { session }) });
  return uiExit(runtime, node, await runtime.processes.run(request));
}
