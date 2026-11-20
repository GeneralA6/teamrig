import { provedOn, type FeatureSide, type Os, type Support } from '../plugin-api/index.ts';
import type { BoundCase, BoundContract } from './contract.ts';

/** What the choice needs to know of a contract of the kit, bound by the adapter or not. */
export interface ContractOutline {
  readonly port: string;
  readonly side: FeatureSide;
  /** Every feature a case of it names. */
  readonly features: readonly string[];
}

export interface ChoiceRequest {
  readonly side: FeatureSide;
  /** The adapter's manifest: what it says of each feature of its side. */
  readonly manifest: Readonly<Record<string, Support>>;
  /** The contracts the adapter binds. */
  readonly bound: readonly BoundContract[];
  /** The operating system the cases would run on. */
  readonly os: Os;
  /** Every contract of the kit. */
  readonly kit: readonly ContractOutline[];
}

/** The cases of one bound contract that run. */
export interface Chosen {
  readonly port: string;
  readonly cases: readonly BoundCase[];
}

export interface Choice {
  readonly chosen: readonly Chosen[];
  /** What the adapter's bindings break; any one fails its suite, whatever its cases do. */
  readonly problems: readonly string[];
}

type Manifest = ChoiceRequest['manifest'];

function supportOf(manifest: Manifest, feature: string): Support | undefined {
  return Object.hasOwn(manifest, feature) ? manifest[feature] : undefined;
}

function claims(manifest: Manifest, feature: string): boolean {
  const support = supportOf(manifest, feature);
  return support !== undefined && support.kind !== 'unsupported';
}

function isLeftOut(contract: BoundContract, one: BoundCase): boolean {
  return Object.hasOwn(contract.without, one.id);
}

/** The cases that run: on this operating system, for a feature the adapter claims, and not left out by the binding. */
function casesOf(request: ChoiceRequest, contract: BoundContract): readonly BoundCase[] {
  return contract.cases.filter((one) => one.os.includes(request.os) && one.features.some((feature) => claims(request.manifest, feature)) && !isLeftOut(contract, one));
}

function rowProblems(manifest: Manifest, contract: BoundContract): readonly string[] {
  return contract.cases.flatMap((one) => one.features.filter((feature) => supportOf(manifest, feature) === undefined).map((feature) => `${one.id} names ${feature}, which the manifest has no row for`));
}

function leftOutProblems(manifest: Manifest, contract: BoundContract): readonly string[] {
  return Object.entries(contract.without).flatMap(([id, reason]) => {
    const one = contract.cases.find((each) => each.id === id);
    if (one === undefined) {
      return [`${contract.port} leaves out ${id}, which is no case of it`];
    }
    const supported = one.features.filter((feature) => supportOf(manifest, feature)?.kind === 'supported');
    return [...supported.map((feature) => `${id} cannot be left out: the manifest says ${feature} is supported`), ...(reason.trim() === '' ? [`${id} is left out with no reason`] : [])];
  });
}

function bindingProblems(request: ChoiceRequest): readonly string[] {
  const ports = request.bound.map((contract) => contract.port);
  return [
    ...request.bound.filter((contract) => contract.side !== request.side).map((contract) => `${contract.port} is a ${contract.side} contract, bound by a ${request.side} adapter`),
    ...[...new Set(ports.filter((port, at) => ports.indexOf(port) !== at))].map((port) => `${port} is bound twice`),
  ];
}

/** A feature the adapter claims whose contract it did not bind: nothing would hold the claim. */
function unboundProblems(request: ChoiceRequest): readonly string[] {
  const bound = new Set(request.bound.map((contract) => contract.port));
  return request.kit
    .filter((contract) => contract.side === request.side && !bound.has(contract.port))
    .flatMap((contract) => contract.features.filter((feature) => claims(request.manifest, feature)).map((feature) => `the manifest says ${feature} is ${supportOf(request.manifest, feature)?.kind ?? 'unknown'}, and its contract ${contract.port} is not bound`));
}

/** A supported feature with a proof on this operating system and cases in a bound contract, none of which runs here. */
function unheldProblems(request: ChoiceRequest, chosen: readonly Chosen[]): readonly string[] {
  const named = new Set(request.bound.flatMap((contract) => contract.cases.flatMap((one) => one.features)));
  const run = new Set(chosen.flatMap((each) => each.cases.flatMap((one) => one.features)));
  return [...named]
    .filter((feature) => !run.has(feature))
    .filter((feature) => {
      const support = supportOf(request.manifest, feature);
      return support?.kind === 'supported' && provedOn(support).includes(request.os);
    })
    .map((feature) => `the manifest says ${feature} is supported and proved on ${request.os}, and no case of it runs there`);
}

/**
 * Which cases run for one adapter on one operating system, picked by its manifest: a supported feature runs every
 * case of it, a partial one may leave some out with a reason, an unsupported one runs none.
 */
export function choiceOf(request: ChoiceRequest): Choice {
  const chosen = request.bound.map((contract) => ({ port: contract.port, cases: casesOf(request, contract) }));
  return {
    chosen,
    problems: [
      ...bindingProblems(request),
      ...request.bound.flatMap((contract) => [...rowProblems(request.manifest, contract), ...leftOutProblems(request.manifest, contract)]),
      ...unboundProblems(request),
      ...unheldProblems(request, chosen),
    ],
  };
}
