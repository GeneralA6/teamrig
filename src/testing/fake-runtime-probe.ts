import type { RuntimeImage, RuntimeProbe } from '../exec/runtime-pin.ts';

/** The runtime a fake client runs under: node at /usr/bin/node, its binary hashing to 64 `a`s. */
export const FAKE_RUNTIME: RuntimeImage = { path: '/usr/bin/node', sha256: 'a'.repeat(64), version: 'v22.11.0' };

/** A runtime probe a test sets: `image` is what `current()` reads, or `error` what it throws. */
export class FakeRuntimeProbe implements RuntimeProbe {
  image: RuntimeImage;
  error: Error | undefined;
  /** How many times the runtime was read: each read hashes the binary anew. */
  reads = 0;

  constructor(image: RuntimeImage = FAKE_RUNTIME) {
    this.image = image;
  }

  async current(): Promise<RuntimeImage> {
    this.reads += 1;
    if (this.error !== undefined) {
      throw this.error;
    }
    return this.image;
  }
}
