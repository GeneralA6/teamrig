import { isRecord } from "../core/guards.js";
/** The CLI flags that write a card's parts, for the refusals that name them. */
export const CARD_FLAGS = '--question, --options, --recommend and --default';
/** The CLI flag that writes a card's `whyAsk`. */
export const WHY_ASK_FLAG = '--why-ask';
/** How to say why the owner (`ownerSource`) is asked about what the owner ordered (T802). */
export function whyAskUsage(ownerSource) {
    return `${WHY_ASK_FLAG} "<how the order must change, what new it needs, or why only ${ownerSource} can see the result>"`;
}
/** How `--options` separates the choices: a comma or a semicolon is common inside one. */
export const OPTION_SEPARATOR = '|';
/** The fewest plain words each part of a card says; task ids do not count. */
export const CARD_MIN_WORDS = 3;
/** The fewest options a decision lists; an approval asks yes or no and may list none. */
export const MIN_DECISION_OPTIONS = 2;
/** A task id standing as a word: `T378`, `(T378)`, `T378,`. */
const TASK_WORD = /\bT[1-9]\d*\b/g;
/** The card's parts as one list of texts, in the order a card prints them. */
export function cardTexts(card) {
    return [card.question, ...(card.whyAsk === undefined ? [] : [card.whyAsk]), ...card.options, card.recommend, card.byDefault];
}
/** The card without its `whyAsk`: what it keeps once its task waits on no owner's decision or approval. */
export function withoutWhyAsk(card) {
    return { question: card.question, options: card.options, recommend: card.recommend, byDefault: card.byDefault };
}
/** How many words a text says besides task ids: letters and digits in runs, so `30 days: 4 GB` is four. */
export function plainWords(text) {
    return text
        .replace(TASK_WORD, ' ')
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word !== '').length;
}
/** Every task id the texts name, in the order first named, each once. */
export function namedTaskIds(texts) {
    return [...new Set(texts.flatMap((text) => text.match(TASK_WORD) ?? []))];
}
/**
 * Why a card cannot be written, or undefined: every part says at least CARD_MIN_WORDS plain words, so a bare
 * task number (`option B of T378`) is refused; a decision lists at least MIN_DECISION_OPTIONS options, and an
 * approval none or as many.
 */
export function cardProblem(card, decision) {
    const parts = [
        ['--question', card.question],
        ...(card.whyAsk === undefined ? [] : [[WHY_ASK_FLAG, card.whyAsk]]),
        ...card.options.map((option, index) => [`--options choice ${index + 1}`, option]),
        ['--recommend', card.recommend],
        ['--default', card.byDefault],
    ];
    const thin = parts.find(([, text]) => plainWords(text) < CARD_MIN_WORDS);
    if (thin !== undefined) {
        return `${thin[0]} says "${thin[1]}": give at least ${CARD_MIN_WORDS} plain words besides task ids, so it reads without the task list`;
    }
    if (card.options.length === 1 || (decision && card.options.length < MIN_DECISION_OPTIONS)) {
        return `--options lists ${card.options.length}: a decision lists at least ${MIN_DECISION_OPTIONS}, separated by ${OPTION_SEPARATOR}${decision ? '' : '; an approval lists none or as many'}`;
    }
    return undefined;
}
/** True when both cards say the same, so setting one again changes nothing. */
export function sameCard(a, b) {
    if (a === null || b === null) {
        return a === b;
    }
    return (a.question === b.question &&
        a.recommend === b.recommend &&
        a.byDefault === b.byDefault &&
        a.whyAsk === b.whyAsk &&
        a.options.length === b.options.length &&
        a.options.every((option, index) => option === b.options[index]));
}
/**
 * A status line's card: undefined when absent or null, else its parts, or the reason it is not a card. Parsing
 * checks the format only; what a card must say is judged on write (cardProblem).
 */
export function parseCard(value) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        return 'card is not an object';
    }
    const { question, options, recommend, byDefault, whyAsk } = value;
    if (typeof question !== 'string' || typeof recommend !== 'string' || typeof byDefault !== 'string') {
        return 'card needs question, recommend and byDefault as text';
    }
    if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
        return 'card options is not a list of texts';
    }
    if (whyAsk !== undefined && typeof whyAsk !== 'string') {
        return 'card whyAsk is not text';
    }
    return { question, options, recommend, byDefault, ...(whyAsk === undefined ? {} : { whyAsk }) };
}
/**
 * A card as printed under its task: the question, why the owner is asked (when the card says), each option
 * numbered, the recommendation and the default, each line led by `indent`.
 */
export function cardLines(card, indent) {
    return [
        `${indent}decide: ${card.question}`,
        ...(card.whyAsk === undefined ? [] : [`${indent}why asked: ${card.whyAsk}`]),
        ...card.options.map((option, index) => `${indent}  ${index + 1}. ${option}`),
        `${indent}recommended: ${card.recommend}`,
        `${indent}with no answer: ${card.byDefault}`,
    ];
}
