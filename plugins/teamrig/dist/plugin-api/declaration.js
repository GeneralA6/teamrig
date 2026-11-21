import { isRecord, stringField } from "../core/guards.js";
import { manifestProblems } from "./support.js";
import { isApiVersion } from "./version.js";
export const ADAPTER_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** What stops `value` from being the declaration of an adapter of one side; empty when it is one. */
export function declarationProblems(side, value) {
    if (!isRecord(value)) {
        return ['its declaration is not an object'];
    }
    const apiVersion = stringField(value, 'apiVersion');
    const id = stringField(value, 'id');
    const name = stringField(value, 'name');
    return [
        ...(apiVersion !== undefined && isApiVersion(apiVersion) ? [] : ['its apiVersion must be a version like 1.0.0']),
        ...(id !== undefined && ADAPTER_ID.test(id) ? [] : ['its id must be lower-case words joined by -']),
        ...(name !== undefined && name.trim() !== '' ? [] : ['it needs a name']),
        ...manifestProblems(side, value['manifest']),
    ];
}
/** The entry when `value` has the shape `defineHost`, `defineConnector` and `defineTerminal` return: a declaration and a `create` function. */
export function adapterEntry(value) {
    return isRecord(value) && typeof value['create'] === 'function' ? { declaration: value['declaration'] } : undefined;
}
