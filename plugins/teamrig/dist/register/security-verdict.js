import { isRecord } from "../core/guards.js";
/** The parts of `card` a verdict reads. */
export function verdictReadOf(card) {
    return { question: card.question, options: [...card.options], recommend: card.recommend };
}
/** True when `card` still asks what `verdict` was given on: the same question, options in order and recommendation. */
export function verdictIsCurrent(verdict, card) {
    const { read } = verdict;
    return (read.question === card.question &&
        read.recommend === card.recommend &&
        read.options.length === card.options.length &&
        read.options.every((option, index) => option === card.options[index]));
}
/** The verdict pin an update line gives, or why it is not one. */
export function parseSecurityVerdictPin(value) {
    if (!isRecord(value) || typeof value['text'] !== 'string' || value['text'].trim() === '') {
        return `bad security verdict ${JSON.stringify(value)}`;
    }
    const read = value['read'];
    if (!isRecord(read)) {
        return `bad security verdict ${JSON.stringify(value)}`;
    }
    const { question, options, recommend } = read;
    if (typeof question !== 'string' || typeof recommend !== 'string' || !Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
        return `bad security verdict ${JSON.stringify(value)}`;
    }
    return { text: value['text'], read: { question, options, recommend } };
}
