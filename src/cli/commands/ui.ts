import type { KitConfig } from '../../config/types.ts';
import type { Env } from '../../core/home.ts';
import { ID_PATTERN, ID_RULE } from '../../core/ids.ts';
import type { RunOutcome } from '../../open/processes.ts';
import { RELEASED_UI } from '../../ui/pin.ts';
import { releasedEntry, type UiPin } from '../../ui/released.ts';
import { releasedEnv, uiRequest } from '../../ui/start.ts';
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

/** The UI's entry script and the environment it runs with. */
interface UiEntry {
  readonly entry: string;
  readonly env: Env;
}

/**
 * The UI to start. `ui.path`, the owner's own build, wins and keeps the whole environment, as it is theirs. Without
 * it, the released UI `pin` names, fetched and installed under the kit home once and held to the pin at each start,
 * runs with only the variables `releasedEnv` keeps. With neither there is nothing to start.
 */
async function entryOf(config: KitConfig, runtime: CliRuntime, kit: Kit, pin: UiPin | undefined): Promise<UiEntry> {
  const { path } = config.ui;
  if (path !== undefined) {
    if ((await runtime.probe.kind(path)) !== 'file') {
      throw new RefusedError(`ui.path names ${path}, and no file is there; fix or remove ui.path in the team config`);
    }
    return { entry: path, env: runtime.env };
  }
  if (pin === undefined) {
    throw new RefusedError('no released UI is pinned in this teamrig yet; set ui.path in the team config to a UI entry script of your own build');
  }
  const deps = { files: runtime.files, http: runtime.http, nonce: () => runtime.newId() };
  const released = await releasedEntry(deps, kit.paths.kitHome, pin);
  if (!released.ok) {
    throw new RefusedError(released.reason);
  }
  return { entry: released.entry, env: releasedEnv(runtime.env) };
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
 * Node.js and is handed this CLI to call back (ui/start.ts). `pin` is the released UI it starts without `ui.path`:
 * `RELEASED_UI` in the CLI, another in a spec.
 */
export function uiCommand(pin: UiPin | undefined): (args: ParsedArgs, runtime: CliRuntime) => Promise<ExitCode> {
  return async (args, runtime) => {
    noPositionals(args);
    const kit = await kitOf(args.flags.get('team'), runtime);
    const config = requireConfig(kit, runtime, 'read');
    const named = args.flags.get('session');
    const session = named === undefined ? undefined : sessionIdOf(await rosterOf(runtime, kit, config), named);
    const { entry, env } = await entryOf(config, runtime, kit, pin);
    const { node, script } = runtime.self;
    const request = uiRequest({ entry, node, script, team: kit.paths.team, cwd: runtime.cwd, env, ...(session === undefined ? {} : { session }) });
    return uiExit(runtime, node, await runtime.processes.run(request));
  };
}

/** `teamrig ui`, starting the released UI this teamrig pins. */
export const ui = uiCommand(RELEASED_UI);
