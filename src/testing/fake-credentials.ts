import type { CredentialRead, CredentialSave, CredentialStore } from '../github/credentials.ts';

/** A store of saved secrets held in memory: empty until a test saves one, and each read is recorded. */
export class FakeCredentials implements CredentialStore {
  readonly label = 'the test store';
  /** The names read, in order. */
  readonly reads: string[] = [];
  /** The names saved through `save`, in order; the secrets are only in the store. */
  readonly saved: string[] = [];
  private readonly held = new Map<string, CredentialRead>();
  private saveFailure: string | undefined;

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

  /** From now on, every `save` fails with `reason`, as a store with no keyring running does. */
  failsSaving(reason: string): this {
    this.saveFailure = reason;
    return this;
  }

  saveCommand(name: string): string {
    return `save ${name}`;
  }

  async read(name: string): Promise<CredentialRead> {
    this.reads.push(name);
    return this.held.get(name) ?? { kind: 'missing' };
  }

  async save(name: string, secret: string): Promise<CredentialSave> {
    if (this.saveFailure !== undefined) {
      return { kind: 'failed', reason: this.saveFailure };
    }
    this.saved.push(name);
    this.held.set(name, { kind: 'found', secret });
    return { kind: 'saved' };
  }
}
