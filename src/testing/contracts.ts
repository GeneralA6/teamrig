import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACTS, choiceOf, osOf, type BoundCase, type BoundContract, type ContractOutline } from '../conformance/index.ts';
import type { AdapterDeclaration, Os } from '../plugin-api/index.ts';

/**
 * An adapter as its contract spec gives it: what it declares, and the contracts it binds. The sides are spelled out
 * so one side's manifest is never read with another's contracts.
 */
export type ContractsOf =
  | { readonly side: 'host'; readonly declaration: AdapterDeclaration<'host'>; readonly bound: readonly BoundContract<'host'>[] }
  | { readonly side: 'connector'; readonly declaration: AdapterDeclaration<'connector'>; readonly bound: readonly BoundContract<'connector'>[] }
  | { readonly side: 'terminal'; readonly declaration: AdapterDeclaration<'terminal'>; readonly bound: readonly BoundContract<'terminal'>[] };

export interface SuiteRequest {
  /** The operating system the cases run on; none when the machine's is not one a proof is made on. */
  readonly os: Os | undefined;
  /** Every contract of the kit. */
  readonly kit: readonly ContractOutline[];
}

/** The cases of one port that run, under the port's name. */
export interface SuiteGroup {
  readonly port: string;
  readonly cases: readonly BoundCase[];
}

export interface Suite {
  readonly name: string;
  /** A port with no case to run has no group. */
  readonly groups: readonly SuiteGroup[];
  /** What the adapter's bindings break; the suite fails on any one, whatever its cases do. */
  readonly problems: readonly string[];
}

/** The suite of one adapter on one operating system: the cases its manifest picks, and what its bindings break. */
export function suiteOf(adapter: ContractsOf, request: SuiteRequest): Suite {
  const name = `${adapter.declaration.name} and the contracts of its ports`;
  if (request.os === undefined) {
    return { name, groups: [], problems: ['this operating system is none a case runs on: no contract holds the adapter here'] };
  }
  const choice = choiceOf({ side: adapter.side, manifest: adapter.declaration.manifest, bound: adapter.bound, os: request.os, kit: request.kit });
  return { name, groups: choice.chosen.filter((each) => each.cases.length > 0), problems: choice.problems };
}

export interface DescribeOptions {
  /** Left out, the machine's own. */
  readonly os?: Os;
  /** Left out, the kit's own contracts. */
  readonly kit?: readonly ContractOutline[];
}

/**
 * An adapter's whole contract spec: one call in its `<name>.contract.test.ts` runs every case its manifest claims,
 * and fails when it binds less than it claims or leaves out what it may not.
 */
export function describeContracts(adapter: ContractsOf, options: DescribeOptions = {}): void {
  const suite = suiteOf(adapter, { os: options.os ?? osOf(process.platform), kit: options.kit ?? CONTRACTS });
  describe(suite.name, () => {
    for (const group of suite.groups) {
      describe(group.port, () => {
        for (const one of group.cases) {
          it(one.title, one.run);
        }
      });
    }
    it('binds every contract its manifest claims, and leaves out only what it may', () => {
      assert.deepEqual(suite.problems, []);
    });
  });
}
