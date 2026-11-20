import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isRecord } from '../core/guards.ts';
import { canonicalJson, sha256Hex } from './digest.ts';

/**
 * The runtime pin (#870): the client pin (client-integrity.ts) hashes the client's code, and node-launch.ts refuses
 * options that load other code beside it, but neither checks the Node.js program that runs it, which the launchers find
 * on PATH. So `teamrig exec node-pin` files the running runtime (its real path, the SHA-256 of its binary and its
 * version) in the exec audit log, the security reviewer approves it like a request, and a dry run or a run starts only
 * under the runtime the latest approved pin names.
 *
 * A check a runtime runs on itself cannot hold against a hostile runtime, which can answer any check it runs: like the
 * client pin and the option list, this catches a wrong node (a PATH order, a version-manager switch, an unofficial
 * build). Phase 2's read-only install is what holds against a deliberate swap.
 */

/** A pin's id: P1, P2, ... in the order the log holds them. */
export const PIN_ID = /^P[1-9]\d*$/u;

/** How many hex digits of a hash a refusal names. */
export const HASH_PREFIX = 12;

const SHA256 = /^[0-9a-f]{64}$/u;

/** The Node.js runtime a client runs under, as the pin names it. */
export interface RuntimeImage {
  /** The runtime's real path: symlinks resolved. */
  readonly path: string;
  /** The SHA-256 of the runtime's binary, as 64 lowercase hex digits. */
  readonly sha256: string;
  /** `process.version`, such as `v22.11.0`. */
  readonly version: string;
}

/** A runtime filed for review (`teamrig exec node-pin`). */
export interface RuntimePin extends RuntimeImage {
  readonly id: string;
  /** The session that filed it, or the owner. */
  readonly requester: string;
  readonly createdAt: string;
}

/** Reads the running runtime. It hashes the binary on every call: a cache keyed by what a writer controls could go stale. */
export interface RuntimeProbe {
  current(): Promise<RuntimeImage>;
}

/** The SHA-256 of a pin as filed: what its review binds, so an approval names exactly one path, hash and version. */
export function pinSha256(pin: RuntimePin): string {
  return sha256Hex(canonicalJson(pin));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** A pin as the log stores it, or undefined when it is not one. */
export function readStoredPin(raw: unknown): RuntimePin | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const { id, path, sha256, version, requester, createdAt } = raw;
  if (typeof id !== 'string' || !PIN_ID.test(id) || !isText(path) || typeof sha256 !== 'string' || !SHA256.test(sha256) || !isText(version) || !isText(requester)) {
    return undefined;
  }
  return typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? { id, path, sha256, version, requester, createdAt } : undefined;
}

/** Where to find the release hashes a reviewer checks a pin's hash against. */
export function shasumsUrl(version: string): string {
  return `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
}

/** A runtime in words for a refusal: its path, hash prefix and version, and nothing else. */
function described(image: RuntimeImage): string {
  return `${image.path} (${image.sha256.slice(0, HASH_PREFIX)}, ${image.version})`;
}

/** Whether two real paths name one file; Windows paths ignore case and slash direction. */
function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') {
    return left === right;
  }
  const key = (path: string): string => path.replaceAll('/', '\\').toLowerCase();
  return key(left) === key(right);
}

/**
 * Why a dry run or a run must not start under `found`, or undefined when `pin` (the latest approved one) names it: its
 * path and the hash of its binary both match. A runtime with the pinned hash at another path is refused too, so the
 * pin names one install.
 */
export function runtimeRefusal(found: RuntimeImage, pin: RuntimePin | undefined, platform: NodeJS.Platform): string | undefined {
  const upgrade = 'file the runtime to use with teamrig exec node-pin (in your own terminal) and have the security reviewer approve it';
  if (pin === undefined) {
    return `teamrig exec starts a privileged command only under a Node.js runtime the security reviewer approved, and none is approved: ${upgrade}.`;
  }
  if (samePath(found.path, pin.path, platform) && found.sha256 === pin.sha256) {
    return undefined;
  }
  return `the client runs under ${described(found)}, not the approved ${described(pin)} of ${pin.id}. After a Node.js upgrade, ${upgrade}.`;
}

/** The file whose bytes are the running runtime: on Linux the image the kernel runs, so a rename after start cannot point the hash at another file. */
export function imageFileOf(platform: NodeJS.Platform, realPath: string): string {
  return platform === 'linux' ? '/proc/self/exe' : realPath;
}

/** The SHA-256 of a file's bytes, streamed: a node binary is about 100 MB. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    if (Buffer.isBuffer(chunk)) {
      hash.update(chunk);
    }
  }
  return hash.digest('hex');
}

/** The running process's runtime: `process.execPath` with symlinks resolved, its binary hashed on each call, and `process.version`. */
export function processRuntimeProbe(platform: NodeJS.Platform, execPath: string, version: string): RuntimeProbe {
  return {
    async current() {
      const path = await realpath(execPath);
      return { path, sha256: await fileSha256(imageFileOf(platform, path)), version };
    },
  };
}
