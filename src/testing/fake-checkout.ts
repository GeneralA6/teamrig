import { win32 } from 'node:path';
import type { PathKind, PathProbe } from '../core/path-probe.ts';
import type { PathSearchDeps } from '../core/path-search.ts';
import type { CheckoutProbe } from '../exec/binding.ts';
import { execRequest } from './exec-request.ts';

/** A Windows filesystem that holds only the given files. */
export function probeOf(...files: string[]): PathProbe {
  const held = new Set(files.map((file) => win32.normalize(file)));
  return { kind: async (path): Promise<PathKind> => (held.has(win32.normalize(path)) ? 'file' : 'none') };
}

/** A Windows exec PATH of `path` over a filesystem holding only `files`. */
export function searchOf(path: string, ...files: string[]): PathSearchDeps {
  return { env: { PATH: path }, platform: 'win32', probe: probeOf(...files) };
}

const FIXTURE = execRequest().binding;
const REPO = 'repo' in FIXTURE ? FIXTURE.repo : '';

/** A checkout that answers from fields a test sets: by default the fixture request's bound, clean repository with its one lockfile. */
export class FakeCheckout implements CheckoutProbe {
  top: string | undefined = REPO;
  commit: string | undefined = 'commit' in FIXTURE ? FIXTURE.commit : undefined;
  changed: readonly string[] | undefined = [];
  /** File hashes by Windows path. */
  readonly files = new Map<string, string>('lockSha256' in FIXTURE ? [[win32.join(REPO, 'package-lock.json'), FIXTURE.lockSha256]] : []);

  async topLevel(): Promise<string | undefined> {
    return this.top;
  }

  async head(): Promise<string | undefined> {
    return this.commit;
  }

  async changes(): Promise<readonly string[] | undefined> {
    return this.changed;
  }

  async fileSha256(path: string): Promise<string | undefined> {
    return this.files.get(win32.normalize(path));
  }
}
