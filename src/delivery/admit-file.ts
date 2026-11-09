import { isRecord } from '../core/guards.ts';
import type { Files } from '../core/files.ts';
import type { Clock } from '../core/lock.ts';

/**
 * How long one admission may hold the admit file: a step's look at the line, the memory gate's reads (about 2 s) and
 * its take; a claim older than this is an admission that died.
 */
export const ADMIT_TTL_MS = 30_000;

/** Tries per claim: a dead claim removed may be claimed again by another admission first. */
const ATTEMPTS = 3;

/**
 * What the admit file says: what is being admitted, by its id (a waiter's ticket), its process and when the claim runs
 * out. The id is stored as `ticket`, never `token`, which the secret redactor reads as a secret.
 */
interface AdmitClaim {
  readonly ticket: string;
  readonly pid: number;
  readonly expiresAt: string;
}

function isAdmitClaim(value: unknown): value is AdmitClaim {
  return (
    isRecord(value) &&
    typeof value['ticket'] === 'string' &&
    typeof value['pid'] === 'number' &&
    typeof value['expiresAt'] === 'string' &&
    !Number.isNaN(Date.parse(value['expiresAt']))
  );
}

function parseClaim(text: string): AdmitClaim | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isAdmitClaim(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface AdmitFilePorts {
  readonly files: Files;
  readonly clock: Clock;
  /** This process: a claim names it. */
  readonly pid: number;
  /** Whether a process still runs. */
  alive(pid: number): boolean;
}

/**
 * The host's admit file, `<lock>.admit`: one admission at a time holds it while it reads the host's room and takes its
 * share of it, so two admissions never both read the same room as free. It is created whole, naming its process, and
 * runs out after `ADMIT_TTL_MS`; a claim whose process is gone, that ran out or that cannot be read is removed by the
 * next admission that finds it.
 */
export class AdmitFile {
  private readonly path: string;
  private readonly ports: AdmitFilePorts;

  constructor(path: string, ports: AdmitFilePorts) {
    this.path = path;
    this.ports = ports;
  }

  /**
   * Claims the file for the admission of `id`: the text it wrote, which {@link release} takes, while this admission
   * holds it; undefined while another live admission does. A dead claim is removed while its text is unchanged, and
   * the file claimed again.
   */
  async claim(id: string): Promise<string | undefined> {
    const { files, clock, pid } = this.ports;
    const claim: AdmitClaim = { ticket: id, pid, expiresAt: new Date(clock.now() + ADMIT_TTL_MS).toISOString() };
    const text = JSON.stringify(claim);
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      if (await files.createExclusive(this.path, text)) {
        return text;
      }
      const seen = await files.read(this.path);
      if (seen !== undefined) {
        const other = parseClaim(seen);
        if (other !== undefined && this.isLive(other)) {
          return undefined;
        }
        await this.removeWhile(seen);
      }
    }
    return undefined;
  }

  /** Releases the claim written as `text`; one another admission wrote since (once this one ran out) stays. */
  async release(text: string): Promise<void> {
    await this.removeWhile(text);
  }

  private isLive(claim: AdmitClaim): boolean {
    return Date.parse(claim.expiresAt) > this.ports.clock.now() && this.ports.alive(claim.pid);
  }

  private async removeWhile(text: string): Promise<void> {
    const { files } = this.ports;
    if ((await files.read(this.path)) === text) {
      await files.remove(this.path);
    }
  }
}
