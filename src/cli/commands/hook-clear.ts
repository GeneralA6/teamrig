import { resolveKitHome } from '../../core/home.ts';
import { sessionIdOf } from '../../inbox/inbox.ts';
import { CLAIM_HELD, CLAIM_TAKEN, HOLD_SWITCH, isClaudeSessionId } from '../../mod/clear-hand.ts';
import { ClearAsks, clearAskDir } from '../../refresh/clear-asks.ts';
import { RefreshStore } from '../../refresh/store.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { openKit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { parseJson } from './hook-input.ts';

function asksOf(runtime: CliRuntime): ClearAsks {
  return new ClearAsks(runtime.files, clearAskDir(resolveKitHome(runtime.env, runtime.userHome)));
}

/** `hook clear-dir`: prints the folder of the restart's asks, which the plugin's mod watches for its tab's. */
export async function clearDir(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  runtime.out.stdout(clearAskDir(resolveKitHome(runtime.env, runtime.userHome)));
  return EXIT.ok;
}

/** Why the ask was answered before this claim or hold: the restart took it back, or the tab answered it already. */
async function answeredProblem(asks: ClearAsks, claudeSession: string): Promise<string> {
  const outcome = await asks.outcome(claudeSession);
  return outcome === CLAIM_TAKEN || outcome === CLAIM_HELD ? `the ask was already ${outcome}` : 'the restart took its ask back';
}

/** Why the tab may not claim (or hold) its ask; undefined once it has. */
async function claimProblem(runtime: CliRuntime, asks: ClearAsks, claudeSession: string, hold: boolean): Promise<string | undefined> {
  const ask = await asks.ask(claudeSession);
  if (ask === undefined) {
    return 'no ask for this session';
  }
  const kit = await openKit(runtime, ask.team);
  const store = new RefreshStore(runtime.files, kit.paths);
  const request = await store.restart(ask.id);
  if (request?.phase !== 'pending' || request.at !== ask.at || request.claudeSession !== claudeSession) {
    return 'the restart is no longer pending';
  }
  if (!(await (hold ? asks.hold(claudeSession) : asks.claim(claudeSession)))) {
    return answeredProblem(asks, claudeSession);
  }
  // Held: the request stays pending, so the restart waits for quiet and asks again.
  if (!hold) {
    // Claimed: the request goes now, so a prompt typed before the /clear runs is not told it was cancelled.
    await store.clearRestart(ask.id);
  }
  return undefined;
}

/**
 * `hook clear-claim`, run by the plugin's mod with `{"session_id": ...}` on stdin once it sees its tab's
 * ask while no turn runs: claims the ask while the restart it is for is still pending, and prints `taken`
 * (the mod then runs /clear) or `declined: <why>`. With `--hold` (the session still runs a helper, which
 * a /clear or an end could cut off) it holds the ask instead and prints `held`: the request stays pending
 * and the restart, seeing `held`, ends nothing and asks again once the session is quiet. Whichever of
 * the tab's answer and the restart's withdraw comes first wins.
 */
export async function clearClaim(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const hold = args.switches.has(HOLD_SWITCH);
  const claudeSession = sessionIdOf(parseJson(await runtime.readStdin()));
  const problem =
    claudeSession === null || !isClaudeSessionId(claudeSession)
      ? 'no Claude Code session id on stdin'
      : await claimProblem(runtime, asksOf(runtime), claudeSession, hold);
  runtime.out.stdout(problem !== undefined ? `declined: ${problem}` : hold ? CLAIM_HELD : CLAIM_TAKEN);
  return EXIT.ok;
}
