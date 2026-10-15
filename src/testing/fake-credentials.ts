import type { CredentialRead, CredentialStore } from '../github/credentials.ts';

/** A store of saved secrets held in memory: empty until a test saves one, and each read is recorded. */
export class FakeCredentials implements CredentialStore {
  readonly label = 'the test store';
  /** The names read, in order. */
  readonly reads: string[] = [];
  private readonly held = new Map<string, CredentialRead>();

  /** From now on, `name` holds `secret`. */
  saves(name: string, secret: string): this {
    this.held.set(name, { kind: 'found', secret });
    return this;
  }

  /** From now on, reading `name` fails with `reason`, as a locked keyring does. */
  failsOn(name: string, reason: string): this {
    this.held.set(name, { kind: 'failed', reason });
    return this;
  }

  saveCommand(name: string): string {
    return `save ${name}`;
  }

  async read(name: string): Promise<CredentialRead> {
    this.reads.push(name);
    return this.held.get(name) ?? { kind: 'missing' };
  }
}
