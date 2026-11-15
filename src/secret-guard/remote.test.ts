import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { programsOf } from '../package-guard/programs.ts';
import { describeFinding } from './findings.ts';
import { remoteFindings, remoteLineOf, skipOptions, type InnerLine, type RemoteLine } from './remote.ts';

/** What the line's programs print from elsewhere, with each line they run elsewhere recorded and read as one finding. */
function remote(command: string): { readonly findings: string[]; readonly lines: string[] } {
  const lines: string[] = [];
  const inner: InnerLine = (line, dialect) => {
    lines.push(`${dialect}: ${line}`);
    return [{ kind: 'file', path: 'inner' }];
  };
  const findings = programsOf(command, { cwd: 'C:/w', home: 'C:/u', dialect: 'bash' })
    .flatMap((run) => remoteFindings(run, inner))
    .map(describeFinding);
  return { findings, lines };
}

const KUBE = "a Kubernetes secret's data";

describe('remoteFindings', () => {
  it("reads a kubectl call that prints a secret's data", () => {
    const lines = [
      'kubectl get secret app -o yaml',
      'kubectl -n prod get secrets/app -ojsonpath={.data.token}',
      'kubectl get secret app --output=json',
      'kubectl get cm,secret -o yaml',
      'kubectl get secret app --template={{.data}}',
      'kubectl view-secret app',
      'kubectl create secret generic x --from-env-file=.env --dry-run=client -o yaml',
      'kubectl edit secret app',
    ];
    assert.deepEqual(remote(lines.join('; ')).findings, Array(lines.length).fill(KUBE));
  });

  it('lets a kubectl call that prints no secret data pass', () => {
    const line = 'kubectl get secrets; kubectl describe secret app; kubectl get pods -o yaml; kubectl get secret app -o name; kubectl create secret generic x --from-env-file=.env';
    assert.deepEqual(remote(line), { findings: [], lines: [] });
  });

  it('reads the command a container runs as a quoted bash line', () => {
    assert.deepEqual(remote(`kubectl exec -n prod deploy/api -c app -- sh -c 'cat .env'`).lines, ["bash: 'sh' '-c' 'cat .env'"]);
    assert.deepEqual(remote('docker exec -it -e X=1 api cat "$APP/.env"').lines, ['bash: \'cat\' "$APP/.env"']);
    // The calling shell fills $HOME before docker runs, so the container is handed the caller's home.
    assert.deepEqual(remote('docker exec api cat "$HOME/.env"').lines, ["bash: 'cat' 'C:/u/.env'"]);
    assert.deepEqual(remote("docker compose exec web printenv; podman container exec c env; docker exec c echo \"it's\"").lines, [
      "bash: 'printenv'",
      "bash: 'env'",
      "bash: 'echo' 'it'\\''s'",
    ]);
    assert.deepEqual(remote('docker exec api; docker ps; kubectl exec p').lines, []);
  });

  it('reads the command ssh runs as the line the remote shell reads', () => {
    const read = remote("ssh -i ~/.ssh/k -p 22 host 'cat .env | wc -c'; ssh host; ssh -t host printenv GH_TOKEN");
    assert.deepEqual(read.lines, ['bash: cat .env | wc -c', 'bash: printenv GH_TOKEN']);
    assert.deepEqual(read.findings, ['the content of inner', 'the content of inner']);
  });

  it('reads no line from a kubectl exec with nothing after its dashes', () => {
    assert.deepEqual(remote('kubectl exec p --; ssh -p 22 host'), { findings: [], lines: [] });
  });
});

describe('remoteLineOf', () => {
  const linesOf = (command: string): (RemoteLine | undefined)[] =>
    programsOf(command, { cwd: 'C:/w', home: 'C:/u', dialect: 'bash' }).map(remoteLineOf);

  it('names the line a container or a remote host runs', () => {
    const line = "kubectl -n prod exec deploy/api -- docsh --eval 'db.orders.drop()'; docker exec -u 0 api kvcli DEL k; ssh -p 22 host 'psql -c \"DROP TABLE t\"'";
    assert.deepEqual(linesOf(line), [
      { line: "'docsh' '--eval' 'db.orders.drop()'", dialect: 'bash' },
      { line: "'kvcli' 'DEL' 'k'", dialect: 'bash' },
      { line: 'psql -c "DROP TABLE t"', dialect: 'bash' },
    ]);
  });

  it('names no line for a call that runs nothing elsewhere', () => {
    assert.deepEqual(linesOf('kubectl get pods; kubectl exec p --; kubectl exec p; docker ps; ssh host; git status'), Array(6).fill(undefined));
  });
});

describe('skipOptions', () => {
  it('skips options and the value of each valued one, and stops after a bare --', () => {
    const valued = new Set(['-n']);
    assert.equal(skipOptions(['-n', 'prod', '-v', 'exec', 'p'], 0, valued), 3);
    assert.equal(skipOptions(['-v', '--', '-x'], 0, valued), 2);
    assert.equal(skipOptions(['a', '-n', 'b', 'c'], 1, valued), 3);
    assert.equal(skipOptions(['-v'], 0, valued), 1);
  });
});
