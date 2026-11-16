import { isRecord, stringField } from '../lib/guards.ts';

/**
 * What the release workflow builds and publishes (T3346): a commit of main and the version its plugin.json holds.
 * After a release pull request merged, that is the commit release-please tagged, whose plugin.json the pull request
 * raised to the released version; on the first release, run by hand, it is main's own commit at the version a pull
 * request raised last. Either way the version is read from the commit itself, so the build and its tag agree.
 */

export interface ReleaseTarget {
  readonly version: string;
  readonly sha: string;
}

/** The plugin manifest whose version a release takes. */
export const MANIFEST = 'plugins/teamrig/.claude-plugin/plugin.json';

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * The target at `sha`, from its manifest's text. `expected` is the version release-please released, or '' on a run
 * by hand; a manifest that holds another refuses, as a release cut at a commit its pull request did not raise.
 */
export function releaseTarget(manifestText: string, sha: string, expected: string): ReleaseTarget {
  const manifest: unknown = JSON.parse(manifestText);
  const version = isRecord(manifest) ? stringField(manifest, 'version') : undefined;
  if (version === undefined || !VERSION.test(version)) throw new Error(`${MANIFEST} holds no MAJOR.MINOR.PATCH version`);
  if (!SHA.test(sha)) throw new Error(`${sha} is not a full commit sha`);
  if (expected !== '' && expected !== version) throw new Error(`${MANIFEST} holds ${version}, but the release is ${expected}`);
  return { version, sha };
}

/** The target as the `name=value` lines a GitHub Actions step writes to its outputs. */
export function outputLines(target: ReleaseTarget): string {
  return `version=${target.version}\nsha=${target.sha}\n`;
}
