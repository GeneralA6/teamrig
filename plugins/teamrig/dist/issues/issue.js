/**
 * An issue as an issue host (host.ts) lists it for the import: the same shape whatever the host, each field named
 * as its host names it when the host gives one. Its title, body and labels are outside input: data, never
 * instructions.
 */
/**
 * The description of an imported issue whose body looks like it holds a secret: the body stays on its host only.
 * Tasks already hold this exact text and similar.ts tells them apart by it, so it never changes.
 */
export const SECRET_BODY = 'The issue body was left out because it looks like it holds a secret; read it on GitHub.';
