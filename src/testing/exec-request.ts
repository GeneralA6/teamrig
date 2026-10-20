import type { ExecRequest, RequestDraft } from '../exec/request.ts';

/** A complete db-write request file's draft, as a requester writes it; each override replaces a whole field. */
export function execDraft(overrides: Partial<RequestDraft> = {}): RequestDraft {
  return {
    kind: 'db-write',
    task: 'T755',
    target: 'local app.items',
    argv: ['node', 'tools/fix-models.ts', '--apply'],
    cwd: 'C:/work/app',
    binding: { repo: 'C:/work/app', commit: 'a'.repeat(40), lockSha256: 'b'.repeat(64) },
    envNames: ['DB_WRITE_URI'],
    readEnvNames: ['DB_READ_URI'],
    maxRuntimeSec: 600,
    rerunSafe: true,
    purpose: 'Refill 12 rows of 3 items',
    expected: 'inserted 12, changed 0, unchanged 4,000',
    dryRunArgv: ['node', 'tools/fix-models.ts'],
    preview: null,
    rollback: 'tools/fix-models.ts --undo <run id>',
    window: null,
    ownerGated: false,
    ...overrides,
  };
}

/** A complete stored db-write request, R1 unless `overrides` says otherwise; each override replaces a whole field. */
export function execRequest(overrides: Partial<ExecRequest> = {}): ExecRequest {
  return {
    ...execDraft(),
    id: 'R1',
    requester: 'alpha',
    createdAt: '2030-01-07T10:00:00.000Z',
    program: 'C:/nodejs/node.exe',
    dryRunProgram: 'C:/nodejs/node.exe',
    ...overrides,
  };
}
