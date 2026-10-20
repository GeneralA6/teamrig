import type { Advisory, PackageDoc, PackageRegistry } from '../package-guard/registry.ts';

/** A package a test puts on the fake registry: its dist-tags and each version's publish time as an ISO date. */
export interface FakePackage {
  readonly distTags?: Readonly<Record<string, string>>;
  readonly published: Readonly<Record<string, string>>;
}

/**
 * A registry in memory: the packages and advisories a test puts on it, or a failure every ask throws. It keeps what
 * it was asked, and, as the real service does, returns an advisory only when its package's name was asked about.
 */
export class FakePackageRegistry implements PackageRegistry {
  readonly docsAsked: string[] = [];
  readonly advisoriesAsked: ReadonlyMap<string, readonly string[]>[] = [];
  private readonly packages: ReadonlyMap<string, PackageDoc>;
  private readonly known: readonly Advisory[];
  private readonly failure: Error | undefined;

  constructor(packages: Readonly<Record<string, FakePackage>> = {}, known: readonly Advisory[] = [], failure: Error | undefined = undefined) {
    this.known = known;
    this.failure = failure;
    this.packages = new Map(
      Object.entries(packages).map(([name, spec]) => [
        name,
        {
          distTags: new Map(Object.entries(spec.distTags ?? {})),
          published: new Map(Object.entries(spec.published).map(([version, time]) => [version, Date.parse(time)])),
        },
      ]),
    );
  }

  async packageDoc(name: string, signal: AbortSignal): Promise<PackageDoc | undefined> {
    signal.throwIfAborted();
    this.docsAsked.push(name);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.packages.get(name);
  }

  async advisories(versions: ReadonlyMap<string, readonly string[]>, signal: AbortSignal): Promise<readonly Advisory[]> {
    signal.throwIfAborted();
    this.advisoriesAsked.push(versions);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.known.filter((advisory) => versions.has(advisory.name));
  }
}
