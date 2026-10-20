import { isRecord, recordField, stringField } from '../core/guards.ts';

/** A package as the install guard reads it from the registry. */
export interface PackageDoc {
  /** Each dist-tag's version: `latest` to `4.17.21`. */
  readonly distTags: ReadonlyMap<string, string>;
  /** Each version's publish time, in epoch milliseconds. */
  readonly published: ReadonlyMap<string, number>;
}

/** A known advisory against a package, as the registry's bulk advisory service states it. */
export interface Advisory {
  readonly name: string;
  readonly title: string;
  readonly severity: string;
  readonly url: string;
}

/** The package registry, as the install guard asks it. */
export interface PackageRegistry {
  /** The package's dist-tags and publish times; undefined when the registry has no package of that name. */
  packageDoc(name: string, signal: AbortSignal): Promise<PackageDoc | undefined>;
  /**
   * The advisories against the versions asked about, by package name. The service leaves out an advisory that
   * spares every version asked about, so each one returned affects at least one of them.
   */
  advisories(versions: ReadonlyMap<string, readonly string[]>, signal: AbortSignal): Promise<readonly Advisory[]>;
}

/** The public registry, which also holds the advisory database. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

/** A package's path on the registry: a scope's slash is escaped (`@types%2Fnode`). */
function packagePath(name: string): string {
  return encodeURIComponent(name).replace(/^%40/, '@');
}

function packageDocOf(raw: unknown, name: string): PackageDoc {
  if (!isRecord(raw)) {
    throw new Error(`the registry sent ${name}'s document as something other than an object`);
  }
  const distTags = new Map<string, string>();
  for (const [tag, version] of Object.entries(recordField(raw, 'dist-tags') ?? {})) {
    if (typeof version === 'string') {
      distTags.set(tag, version);
    }
  }
  const published = new Map<string, number>();
  for (const [version, time] of Object.entries(recordField(raw, 'time') ?? {})) {
    const at = typeof time === 'string' ? Date.parse(time) : Number.NaN;
    if (!Number.isNaN(at)) {
      published.set(version, at);
    }
  }
  return { distTags, published };
}

function advisoriesOf(raw: unknown): Advisory[] {
  if (!isRecord(raw)) {
    throw new Error("the registry's advisory service answered with something other than an object");
  }
  return Object.entries(raw).flatMap(([name, list]) =>
    (Array.isArray(list) ? list : []).filter(isRecord).map((entry) => ({
      name,
      title: stringField(entry, 'title') ?? 'an untitled advisory',
      severity: stringField(entry, 'severity') ?? 'unknown',
      url: stringField(entry, 'url') ?? '',
    })),
  );
}

/** The registry at `base` over HTTP: a package's full document (its publish times are not in the short one) and one bulk advisory request. */
export function httpPackageRegistry(base: string = NPM_REGISTRY): PackageRegistry {
  const root = base.endsWith('/') ? base : `${base}/`;
  return {
    async packageDoc(name, signal) {
      const response = await fetch(`${root}${packagePath(name)}`, { signal, headers: { accept: 'application/json' } });
      if (response.status === 404) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`the registry answered ${response.status} for ${name}`);
      }
      const raw: unknown = await response.json();
      return packageDocOf(raw, name);
    },
    async advisories(versions, signal) {
      const body = JSON.stringify(Object.fromEntries([...versions].map(([name, list]) => [name, [...list]])));
      const response = await fetch(`${root}-/npm/v1/security/advisories/bulk`, {
        method: 'POST',
        signal,
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body,
      });
      if (!response.ok) {
        throw new Error(`the registry's advisory service answered ${response.status}`);
      }
      const raw: unknown = await response.json();
      return advisoriesOf(raw);
    },
  };
}
