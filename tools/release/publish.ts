import type { Git } from '../lib/git.ts';

/**
 * Publishes a release's build (T3346). The marketplace entry installs the plugin from the `release` branch, so a
 * release's commit on main is made again there with the compiled dist on top: the next commit of that branch, tagged
 * `v<version>` so an install can pin it. Its parents are the branch's last release and the main commit it was built
 * from, so the branch only moves forward and each build names its source. A tag never moves, and a run again for a
 * release already published changes nothing, so a re-run workflow is safe.
 */

export interface Publication {
  /** The released version, MAJOR.MINOR.PATCH. */
  readonly version: string;
  /** The full sha of main's commit the release was cut at, which is checked out with the dist built in it. */
  readonly source: string;
  /** The branch the marketplace entry installs from. */
  readonly branch: string;
  /** The folder the build writes, added to the commit even when the repo ignores it. */
  readonly dist: string;
  /** The remote both the branch and the tag are pushed to. */
  readonly remote: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

const tagOf = (version: string): string => `refs/tags/v${version}`;

/** The sha a ref has on the remote, or undefined when the remote has no such ref. */
async function remoteSha(git: Git, remote: string, ref: string): Promise<string | undefined> {
  const line = (await git.text(['ls-remote', remote, ref])).split('\n').find((row) => row.endsWith(`\t${ref}`));
  return line?.split('\t')[0];
}

/** The `Name <email>` of the commits git makes here, for the Signed-off-by line. */
async function signer(git: Git): Promise<string> {
  const ident = /^(.+?) <([^<>]+)>/.exec((await git.text(['var', 'GIT_AUTHOR_IDENT'])).trim());
  if (ident === null) throw new Error('cannot read a name and e-mail from the git author ident');
  return `${ident[1]} <${ident[2]}>`;
}

/** Why the publication cannot run, or undefined when its fields are well formed. */
export function publicationProblem(publication: Publication): string | undefined {
  if (!VERSION.test(publication.version)) return `the version ${publication.version} is not MAJOR.MINOR.PATCH`;
  if (!SHA.test(publication.source)) return `the source ${publication.source} is not a full commit sha`;
  return undefined;
}

/**
 * Commits the checked-out source with its built dist onto the release branch and tags it, or finds it done already.
 * Returns the release commit's sha. Refuses a checkout not at the source, a missing dist, and a tag that names
 * another commit.
 */
export async function publishRelease(git: Git, publication: Publication, log: (line: string) => void): Promise<string> {
  const problem = publicationProblem(publication);
  if (problem !== undefined) throw new Error(problem);
  const { version, source, branch, dist, remote } = publication;
  const head = (await git.text(['rev-parse', 'HEAD'])).trim();
  if (head !== source) throw new Error(`the checkout is at ${head}, not the release's source ${source}`);

  // --others lists ignored files too, as the dist is once main stops tracking it.
  if ((await git.text(['ls-files', '--cached', '--others', '--', dist])).trim() === '') throw new Error(`no ${dist} was built to publish`);
  await git.text(['add', '--force', '--', dist]);
  const tree = (await git.text(['write-tree'])).trim();

  const tag = tagOf(version);
  const [last, tagged] = [await remoteSha(git, remote, `refs/heads/${branch}`), await remoteSha(git, remote, tag)];
  if (last !== undefined) {
    await git.text(['fetch', '--quiet', '--no-tags', remote, `refs/heads/${branch}`]);
    const [lastTree, lastParents] = (await git.text(['log', '-1', '--format=%T%n%P', last])).trim().split('\n');
    if (lastTree === tree && (lastParents ?? '').split(' ').includes(source)) {
      if (tagged === last) {
        log(`release: ${branch} and v${version} already hold ${last}, nothing to publish`);
        return last;
      }
      if (tagged !== undefined) throw new Error(`v${version} already tags ${tagged}, not the release ${last}; a tag never moves`);
      await git.text(['push', remote, `${last}:${tag}`]);
      log(`release: ${branch} already held ${last}; tagged it v${version}`);
      return last;
    }
  }
  if (tagged !== undefined) throw new Error(`v${version} already tags ${tagged}; a tag never moves`);

  const message = [
    `release: teamrig ${version}`,
    `The plugin as main's ${source} holds it, with ${dist} built by the release workflow.`,
    `Signed-off-by: ${await signer(git)}`,
  ].join('\n\n');
  const parents = last === undefined ? ['-p', source] : ['-p', last, '-p', source];
  const commit = (await git.text(['commit-tree', tree, ...parents, '-m', message])).trim();
  await git.text(['push', '--atomic', remote, `${commit}:refs/heads/${branch}`, `${commit}:${tag}`]);
  log(`release: published ${version} as ${commit} on ${branch}, tagged v${version}`);
  return commit;
}
