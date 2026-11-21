/**
 * What one W (a weighted token, as the host's usage meter prices a call) of `model` costs against the weekly meter
 * (`budget.modelWeights`): the weight of the longest listed prefix of the model id, else 1. A line naming no model
 * counts 1, since its cost cannot be told apart. The longest prefix wins, so one release can be priced apart:
 * a listed `claude-fable-5-1` beside a broader `claude-fable`.
 */
export function modelWeightOf(model, weights) {
    if (model === undefined) {
        return 1;
    }
    let best;
    for (const entry of weights) {
        if (model.startsWith(entry.model) && (best === undefined || entry.model.length > best.model.length)) {
            best = entry;
        }
    }
    return best?.weight ?? 1;
}
