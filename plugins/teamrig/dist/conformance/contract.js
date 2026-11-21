import { OSES } from "../plugin-api/index.js";
export function defineContract(contract) {
    return contract;
}
export function bind(binding) {
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
async function outcomeOf(one) {
    try {
        await one.run();
        return { kind: 'passed' };
    }
    catch (error) {
        return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
}
/** Runs the cases one after the other, a failing one never stopping the next. */
export async function runCases(cases) {
    const results = [];
    for (const one of cases) {
        results.push({ id: one.id, features: one.features, outcome: await outcomeOf(one) });
    }
    return results;
}
/** The operating system a Node platform is, of those a proof is made on. */
export function osOf(platform) {
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
