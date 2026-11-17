import { createPublicKey } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** The most bytes the guard reads of a `.pub.pem` file to tell a public key; a longer file stays a secret (#875). */
export const PUBLIC_KEY_MAX_BYTES = 64 * 1024;

/** The glob that lists every `.pem` file, the one whose `.pub.pem` names the content check may clear. */
export const PEM_GLOB = '**/*.pem';

/** The name ending of a file the content check reads. */
export const PUBLIC_PEM_SUFFIX = '.pub.pem';

const BEGIN = /^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----$/;
const END = /^-----END (PUBLIC KEY|RSA PUBLIC KEY)-----$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Whether the PEM block `lines` is a public key Node's crypto reads: base64 that only looks like one does not parse. */
function parsesAsPublicKey(lines: readonly string[]): boolean {
  try {
    return createPublicKey({ key: `${lines.join('\n')}\n`, format: 'pem' }).type === 'public';
  } catch {
    return false;
  }
}

/**
 * True when `text` holds one or more PEM blocks labelled exactly `PUBLIC KEY` or `RSA PUBLIC KEY` and nothing else but
 * blank lines: each block closed under its own label, base64 alone inside, and each one a public key Node's crypto
 * parses. The label check stays beside the parse, since crypto would also take a private key block and derive its
 * public half. A private key, a key-shaped label around other base64 (a token, a private key's DER), any other block
 * or any other text, even a note, reads as false, so no secret rides in beside a public key.
 */
export function holdsPublicKeysOnly(text: string): boolean {
  let open: string | undefined;
  let block: string[] = [];
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
      block = [line];
    } else if (END.exec(line)?.[1] === open) {
      if (!parsesAsPublicKey([...block, line])) {
        return false;
      }
      open = undefined;
      blocks += 1;
    } else if (BASE64.test(line)) {
      block.push(line);
    } else {
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
    // Opened without blocking and checked on the open file, so a file swapped for a pipe after a check never holds
    // the guard past its hook's time limit, which would let the call through.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) {
      return undefined;
    }
    const buffer = Buffer.alloc(PUBLIC_KEY_MAX_BYTES + 1);
    let size = 0;
    for (;;) {
      const read = readSync(fd, buffer, size, buffer.length - size, size);
      if (read === 0 || size + read === buffer.length) {
        size += read;
        break;
      }
      size += read;
    }
    return size > PUBLIC_KEY_MAX_BYTES ? undefined : buffer.toString('utf8', 0, size);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
