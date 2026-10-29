/**
 * The commits one pushed ref sends: those after the remote's commit, or, for a ref the remote lacks (or whose commit
 * there this repo never fetched), every commit no remote-tracking ref of the remote holds yet.
 */
export type PushRange =
  | { readonly kind: 'after'; readonly base: string; readonly tip: string }
  | { readonly kind: 'unpushed'; readonly tip: string; readonly remote: string };

/** A full commit id: SHA-1, or SHA-256 in a repository made with it. */
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The id git gives a ref that is not there: a deleted local ref, a remote ref not made yet. */
const ZERO = /^0+$/;

/**
 * The ranges a push sends, one per ref, from the lines git writes to a pre-push hook's stdin, `<local ref> <local id>
 * <remote ref> <remote id>`: a delete (local id all zeros) sends none; a remote commit this repo holds bounds its range,
 * else it is every commit not yet on `remote`. A line git would not write throws, so the hook fails closed.
 */
export function pushRanges(stdin: string, remote: string, isCommit: (sha: string) => boolean): PushRange[] {
  const ranges: PushRange[] = [];
  for (const [at, line] of stdin.split('\n').entries()) {
    const text = line.trim();
    if (text === '') {
      continue;
    }
    const [, tip, , base, extra] = text.split(' ');
    if (tip === undefined || base === undefined || extra !== undefined || !SHA.test(tip) || !SHA.test(base)) {
      throw new Error(`pre-push line ${at + 1} is not "<local ref> <local id> <remote ref> <remote id>", as git writes it`);
    }
    if (ZERO.test(tip)) {
      continue;
    }
    ranges.push(!ZERO.test(base) && isCommit(base) ? { kind: 'after', base, tip } : { kind: 'unpushed', tip, remote });
  }
  return ranges;
}

/** `range` as `git log` arguments; its ids are full hex ids, so neither reads as an option. */
export function rangeArgs(range: PushRange): string[] {
  return range.kind === 'after' ? [`${range.base}..${range.tip}`] : [range.tip, '--not', `--remotes=${range.remote}`];
}
