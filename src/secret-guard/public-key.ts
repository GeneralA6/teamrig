import { closeSync, openSync, readSync, statSync } from 'node:fs';

/** The most bytes the guard reads of a `.pub.pem` file to tell a public key; a longer file stays a secret (#875). */
export const PUBLIC_KEY_MAX_BYTES = 64 * 1024;

/** The glob that lists every `.pem` file, the one whose `.pub.pem` names the content check may clear. */
export const PEM_GLOB = '**/*.pem';

/** The name ending of a file the content check reads. */
export const PUBLIC_PEM_SUFFIX = '.pub.pem';

const BEGIN = /^-----BEGIN ((?:[A-Z0-9]+ )*PUBLIC KEY)-----$/;
const END = /^-----END ((?:[A-Z0-9]+ )*PUBLIC KEY)-----$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * True when `text` holds one or more PEM `PUBLIC KEY` blocks (`RSA PUBLIC KEY` too) and nothing else but blank lines:
 * each block closed under its own label, base64 alone inside. A private key block, any other block or any other text,
 * even a note, reads as false, so no secret rides in beside a public key.
 */
export function holdsPublicKeysOnly(text: string): boolean {
  let open: string | undefined;
  let blocks = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (open === undefined) {
      if (line === '') {
        continue;
      }
      open = BEGIN.exec(line)?.[1];
      if (open === undefined) {
        return false;
      }
    } else if (END.exec(line)?.[1] === open) {
      open = undefined;
      blocks += 1;
    } else if (!BASE64.test(line)) {
      return false;
    }
  }
  return open === undefined && blocks > 0;
}

/**
 * The text of the regular file at `path`, read at once, for the content check; undefined when it is no regular file
 * (a folder, or a pipe that would block the guard), cannot be read, or is past {@link PUBLIC_KEY_MAX_BYTES}.
 */
export function readKeyText(path: string): string | undefined {
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) {
      return undefined;
    }
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(PUBLIC_KEY_MAX_BYTES + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    return size > PUBLIC_KEY_MAX_BYTES ? undefined : buffer.toString('utf8', 0, size);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
