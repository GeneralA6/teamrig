import { describeLargeCommits, largeCommits } from "../../push-guard/commit-size.js";
import { noPositionals, requiredFlag } from "../args.js";
import { openTeamKit, requireConfig } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
/**
 * `commits check --base <ref> [--tip <ref>]`: the commits in base..tip (tip default HEAD) that go over
 * the team's size rule with no reason line. Any → REFUSED, exit 2, so an integrate script or CI can gate on it.
 */
export async function check(args, runtime) {
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
