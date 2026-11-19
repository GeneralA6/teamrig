/**
 * The version of the surface an adapter is built against, as semver. Its major rises when a change breaks an
 * adapter, and the loader refuses one built for another major, so an old adapter never half-runs.
 */
export const API_VERSION = '0.1.0';

const SEMVER = /^(\d+)\.\d+\.\d+$/;

function majorOf(version: string): string | undefined {
  return SEMVER.exec(version)?.[1];
}

/** Whether `text` is a plain semver version (`1.4.0`). */
export function isApiVersion(text: string): boolean {
  return SEMVER.test(text);
}

/** Why an adapter built for `declared` cannot load into a teamrig whose plugin API is `current`; undefined when it can. */
export function apiVersionNotice(declared: string, current: string): string | undefined {
  const built = majorOf(declared);
  if (built === undefined) {
    return `its apiVersion ${JSON.stringify(declared)} is not a version like ${current}`;
  }
  return built === majorOf(current) ? undefined : `it is built for plugin API ${declared} and this teamrig has ${current}: their major versions differ`;
}
