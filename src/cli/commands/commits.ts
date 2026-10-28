import { describeLargeCommits, largeCommits } from '../../push-guard/commit-size.ts';
import { noPositionals, requiredFlag, type ParsedArgs } from '../args.ts';
import { openTeamKit, requireConfig } from '../kit.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `commits check --base <ref> [--tip <ref>]`: the commits in base..tip (tip default HEAD) that go over
 * the team's size rule with no reason line. Any one makes it REFUSED, exit 2, so a merge script or CI can gate on it.
 */
export async function check(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const base = requiredFlag(args.flags, 'base');
  const tip = args.flags.get('tip') ?? 'HEAD';
  const rule = requireConfig(await openTeamKit(runtime), runtime, 'read').commits;
  const commits = runtime.commitLog.between(runtime.cwd, base, tip);
  if (commits === undefined) {
    throw new Error(`git cannot list the commits in ${base}..${tip} from ${runtime.cwd}`);
  }
  const large = largeCommits(commits, rule);
  if (large.length > 0) {
    throw new RefusedError(describeLargeCommits(large, rule));
  }
  runtime.out.stdout(`OK ${commits.length} commit(s) in ${base}..${tip}, none over ${rule.maxLines} non-test lines or ${rule.maxFiles} files without a reason`);
  return EXIT.ok;
}
