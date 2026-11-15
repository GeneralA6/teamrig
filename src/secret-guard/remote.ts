import type { ProgramRun } from '../package-guard/programs.ts';
import type { ShellDialect, ShellWord } from '../push-guard/tokenizer.ts';
import type { SecretFinding } from './findings.ts';

/** Reads a command line run somewhere else, a container or a remote host, for what it prints. */
export type InnerLine = (line: string, dialect: ShellDialect) => SecretFinding[];

/** kubectl options that take the next word as their value, unless written `--name=value`. */
const KUBECTL_VALUED: ReadonlySet<string> = new Set([
  '-n',
  '--namespace',
  '--context',
  '--cluster',
  '--kubeconfig',
  '--user',
  '-s',
  '--server',
  '--token',
  '--as',
  '--as-group',
  '--request-timeout',
  '-l',
  '--selector',
  '--field-selector',
  '-c',
  '--container',
  '-o',
  '--output',
  '--template',
  '-f',
  '--filename',
  '-L',
  '--label-columns',
  '--sort-by',
  '--pod-running-timeout',
]);
/** A resource word that names secrets: `secret`, `secrets/app`, `cm,secret`. */
const SECRET_RESOURCE = /^(?:[\w.-]+,)*secrets?(?:\.v1)?(?:[/,].*)?$/i;
/** An output format that prints a resource's data, not only its name and age. */
const DATA_FORMAT = /^(?:ya?ml|json|jsonpath.*|go-template.*|template.*|custom-columns.*)$/i;

/** docker and podman options of `exec` that take the next word as their value. */
const EXEC_VALUED: ReadonlySet<string> = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys', '--index']);
const CONTAINER_TOOLS: ReadonlySet<string> = new Set(['docker', 'podman', 'nerdctl']);

/** ssh options that take the next word as their value. */
const SSH_VALUED = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split('').map((letter) => `-${letter}`));

/** A command line a call runs somewhere else: in a container or on a remote host. */
export interface RemoteLine {
  readonly line: string;
  readonly dialect: ShellDialect;
}

/**
 * What a call prints from somewhere else: a Kubernetes secret's data (`kubectl get secret -o yaml`), or what the
 * line it runs in a container or on a remote host prints (see {@link remoteLineOf}), read by `inner`.
 */
export function remoteFindings(run: ProgramRun, inner: InnerLine): SecretFinding[] {
  const remote = remoteLineOf(run);
  if (remote !== undefined) {
    return inner(remote.line, remote.dialect);
  }
  return run.name === 'kubectl' || run.name === 'oc' ? kubectlFindings(run.args.map((arg) => arg.text)) : [];
}

/**
 * The line a call runs in a container or on a remote host (`kubectl exec ... -- cmd`, `docker exec c cmd`,
 * `ssh host cmd`), or undefined when it runs none. A container's command runs with no shell, so its words are quoted
 * back into a line; ssh joins them, and the remote shell reads the line. Every guard that reads what a line does
 * elsewhere reads it through this one function.
 */
export function remoteLineOf(run: ProgramRun): RemoteLine | undefined {
  const words = remoteWords(run);
  if (words === undefined || words.length === 0) {
    return undefined;
  }
  const line = run.name === 'ssh' ? words.map((word) => word.text).join(' ') : quoteWords(words);
  return { line, dialect: 'bash' };
}

/** The words of the command a call runs elsewhere, or undefined when it runs none. */
function remoteWords(run: ProgramRun): readonly ShellWord[] | undefined {
  const texts = run.args.map((arg) => arg.text);
  if (run.name === 'kubectl' || run.name === 'oc') {
    const verbAt = skipOptions(texts, 0, KUBECTL_VALUED);
    const dashes = texts.indexOf('--', verbAt + 1);
    return texts[verbAt] === 'exec' && dashes !== -1 ? run.args.slice(dashes + 1) : undefined;
  }
  if (CONTAINER_TOOLS.has(run.name)) {
    const command = containerCommand(texts);
    return command === undefined ? undefined : run.args.slice(run.args.length - command);
  }
  if (run.name === 'ssh') {
    return run.args.slice(skipOptions(texts, 0, SSH_VALUED) + 1);
  }
  return undefined;
}

/** The index of the first word after `start` that is no option, skipping the value of each option in `valued`. */
export function skipOptions(texts: readonly string[], start: number, valued: ReadonlySet<string>): number {
  let index = start;
  while (index < texts.length && (texts[index] ?? '').startsWith('-')) {
    if (texts[index] === '--') {
      return index + 1;
    }
    index += valued.has(texts[index] ?? '') ? 2 : 1;
  }
  return index;
}

/** What a kubectl call that runs nothing elsewhere prints of a secret's data. */
function kubectlFindings(texts: readonly string[]): SecretFinding[] {
  const verbAt = skipOptions(texts, 0, KUBECTL_VALUED);
  const verb = texts[verbAt];
  const rest = texts.slice(verbAt + 1);
  switch (verb) {
    case 'view-secret':
      return [{ kind: 'kube-secret' }];
    case 'get':
    case 'edit':
      return rest.some((text) => SECRET_RESOURCE.test(text)) && (verb === 'edit' || printsData(rest)) ? [{ kind: 'kube-secret' }] : [];
    case 'create':
      return rest[0] === 'secret' && printsData(rest) ? [{ kind: 'kube-secret' }] : [];
    default:
      return [];
  }
}

/** True when the words ask for an output format that prints the data: `-o yaml`, `-ojson`, `--output=jsonpath=...`. */
function printsData(texts: readonly string[]): boolean {
  return texts.some((text, index) => {
    if (text === '-o' || text === '--output') {
      return DATA_FORMAT.test(texts[index + 1] ?? '');
    }
    const joined = /^(?:-o=?|--output=)(.+)$/.exec(text);
    return (joined !== null && DATA_FORMAT.test(joined[1] ?? '')) || text === '--template' || text.startsWith('--template=');
  });
}

/**
 * How many words at the end of a container tool's call make the command it runs in the container: those after the
 * container of `exec`, `container exec` or `compose exec`; undefined when the call runs no command in a container.
 */
function containerCommand(texts: readonly string[]): number | undefined {
  const subcommand = texts[0] === 'container' || texts[0] === 'compose' ? 1 : 0;
  if (texts[subcommand] !== 'exec') {
    return undefined;
  }
  const container = skipOptions(texts, subcommand + 1, EXEC_VALUED);
  const count = texts.length - container - 1;
  return count > 0 ? count : undefined;
}

/** Words quoted back into a bash line: a word only known when it runs keeps its variables in double quotes. */
function quoteWords(words: readonly ShellWord[]): string {
  return words
    .map((word) => (word.dynamic ? `"${word.text.replace(/["\\`]/g, '\\$&')}"` : `'${word.text.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}
