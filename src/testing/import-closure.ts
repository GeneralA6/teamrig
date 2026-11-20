import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

export interface ImportClosure {
  /** Every file reached, relative to `root`, with forward slashes. */
  readonly files: readonly string[];
  /** Each import of something that is not a relative file: `node:` modules and packages alike. */
  readonly outside: readonly string[];
}

/**
 * Follows every import from `entry` (static, `import type`, `export ... from`, side-effect and
 * dynamic), the way TypeScript itself finds them, so comments and strings never count. A spec of a
 * folder that must run without Node built-ins (the read side, the public interface) asserts that
 * `outside` is empty.
 */
export function importClosure(entry: string, root: string, readText: (file: string) => string): ImportClosure {
  const seen = new Set<string>();
  const outside: string[] = [];
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    for (const { fileName } of ts.preProcessFile(readText(file), true, true).importedFiles) {
      if (fileName.startsWith('./') || fileName.startsWith('../')) {
        queue.push(resolve(dirname(file), fileName));
      } else {
        outside.push(`${relative(root, file).replaceAll('\\', '/')} imports ${fileName}`);
      }
    }
  }
  return { files: [...seen].map((file) => relative(root, file).replaceAll('\\', '/')).sort(), outside };
}
