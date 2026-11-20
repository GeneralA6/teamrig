import { OSES, type FeatureIdOf, type FeatureSide, type Os } from '../plugin-api/index.ts';

/** What a case is handed: the port under test, and the world that port sees, which the case scripts. */
export interface Subject<Port, World> {
  readonly port: Port;
  readonly world: World;
}

/**
 * One thing every adapter of a port must do. A case speaks only through its subject, so the same case holds an
 * adapter inside teamrig and an outside program reached through the protocol.
 */
export interface ContractCase<Port, World, Side extends FeatureSide> {
  /** `<port>.<what>`, lower-case words joined by `-`. It never changes once merged: a binding names a case by it. */
  readonly id: string;
  /** Reads as a sentence after the adapter's name. */
  readonly title: string;
  /** The registry rows the case proves. */
  readonly features: readonly FeatureIdOf<Side>[];
  /** The operating systems the case runs on, where its feature exists on some only; left out, it runs on every one. */
  readonly os?: readonly Os[];
  /** Fails by throwing. */
  readonly run: (subject: Subject<Port, World>) => Promise<void> | void;
}

/** Every case of one port, with the subjects that must fail them. */
export interface Contract<Port, World, Side extends FeatureSide> {
  readonly port: string;
  readonly side: Side;
  readonly cases: readonly ContractCase<Port, World, Side>[];
  /** Subjects that claim the port and do nothing, or say yes to everything: a feature one of them passes is not held. */
  readonly liars: readonly (() => Subject<Port, World>)[];
}

export function defineContract<Port, World, Side extends FeatureSide>(contract: Contract<Port, World, Side>): Contract<Port, World, Side> {
  return contract;
}

/** How one adapter meets one contract. */
export interface Binding<Port, World, Side extends FeatureSide> {
  readonly contract: Contract<Port, World, Side>;
  /** A new subject for each case, so no state passes from one case to the next. */
  readonly make: () => Subject<Port, World> | Promise<Subject<Port, World>>;
  /** The cases that do not run for this adapter, each with why. Only a case with no supported feature may be named. */
  readonly without?: Readonly<Record<string, string>>;
}

/** A case with its subject closed over: all a runner needs of it. */
export interface BoundCase {
  readonly id: string;
  readonly title: string;
  readonly features: readonly string[];
  readonly os: readonly Os[];
  readonly run: () => Promise<void>;
}

/** A binding with its port and world types closed over, so one list holds an adapter's bindings of different ports. */
export interface BoundContract<Side extends FeatureSide = FeatureSide> {
  readonly port: string;
  readonly side: Side;
  readonly cases: readonly BoundCase[];
  readonly without: Readonly<Record<string, string>>;
}

export function bind<Port, World, Side extends FeatureSide>(binding: Binding<Port, World, Side>): BoundContract<Side> {
  const { contract, make } = binding;
  return {
    port: contract.port,
    side: contract.side,
    without: binding.without ?? {},
    cases: contract.cases.map((one) => ({
      id: one.id,
      title: one.title,
      features: one.features,
      os: one.os ?? OSES,
      run: async () => {
        await one.run(await make());
      },
    })),
  };
}

export type CaseOutcome = { readonly kind: 'passed' } | { readonly kind: 'failed'; readonly reason: string };

export interface CaseResult {
  readonly id: string;
  readonly features: readonly string[];
  readonly outcome: CaseOutcome;
}

async function outcomeOf(one: BoundCase): Promise<CaseOutcome> {
  try {
    await one.run();
    return { kind: 'passed' };
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Runs the cases one after the other, a failing one never stopping the next. */
export async function runCases(cases: readonly BoundCase[]): Promise<readonly CaseResult[]> {
  const results: CaseResult[] = [];
  for (const one of cases) {
    results.push({ id: one.id, features: one.features, outcome: await outcomeOf(one) });
  }
  return results;
}

/** The operating system a Node platform is, of those a proof is made on. */
export function osOf(platform: NodeJS.Platform): Os | undefined {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'macos';
    default:
      return undefined;
  }
}
