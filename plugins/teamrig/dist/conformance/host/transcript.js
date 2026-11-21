import assert from 'node:assert/strict';
import { defineContract } from "../contract.js";
const REPLY = { text: 'Reading the page first.', call: { id: 'call-1', name: 'reader' } };
function kindOf(entry) {
    return entry?.kind ?? 'no entry';
}
function inputOf(entry) {
    if (entry?.kind !== 'input') {
        assert.fail(`the line read as ${kindOf(entry)}, not as an input`);
    }
    return entry;
}
function replyOf(entry) {
    if (entry?.kind !== 'reply') {
        assert.fail(`the line read as ${kindOf(entry)}, not as a reply`);
    }
    return entry;
}
function titleOf(entry) {
    if (entry?.kind !== 'title') {
        assert.fail(`the line read as ${kindOf(entry)}, not as a title`);
    }
    return entry;
}
const CASES = [
    {
        id: 'transcript.typed-prompt',
        title: "reads a typed prompt as an input of the session's own thread carrying its text",
        features: ['tabs.title-status', 'sessions.turn-end'],
        run: ({ port, world }) => {
            const input = inputOf(port.entry(world.prompt('Fix the login page', 'main')));
            assert.equal(input.text ?? input.parts[0], 'Fix the login page');
            assert.notEqual(input.thread, 'helper');
            assert.equal(input.meta, false);
            assert.deepEqual(input.results, []);
        },
    },
    {
        id: 'transcript.helper-prompt',
        title: "reads a prompt in a helper's thread as a helper's, never as the session's own",
        features: ['budget.helper-weight', 'tabs.title-status'],
        run: ({ port, world }) => {
            assert.equal(inputOf(port.entry(world.prompt('Count the specs', 'helper'))).thread, 'helper');
        },
    },
    {
        id: 'transcript.reply-with-call',
        title: 'reads a reply as its texts and the tool calls it makes, each under its id and name',
        features: ['sessions.turn-end', 'sessions.carry'],
        run: ({ port, world }) => {
            const reply = replyOf(port.entry(world.reply(REPLY)));
            assert.deepEqual(reply.texts, [REPLY.text]);
            assert.deepEqual(reply.calls.map(({ id, name }) => ({ id, name })), [REPLY.call]);
            assert.equal(reply.failed, false);
        },
    },
    {
        id: 'transcript.call-result',
        title: 'reads a tool result as an input that answers its call, with no prompt text of its own',
        features: ['sessions.carry'],
        run: ({ port, world }) => {
            const input = inputOf(port.entry(world.result(REPLY.call.id, 'three files', false)));
            assert.equal(input.text, undefined);
            assert.deepEqual(input.results.map(({ call, isError, text }) => ({ call, isError, text })), [{ call: REPLY.call.id, isError: false, text: 'three files' }]);
        },
    },
    {
        id: 'transcript.failed-result',
        title: 'says a failed tool result failed',
        features: ['sessions.carry'],
        run: ({ port, world }) => {
            const input = inputOf(port.entry(world.result(REPLY.call.id, 'no such folder', true)));
            assert.deepEqual(input.results.map(({ call, isError }) => ({ call, isError })), [{ call: REPLY.call.id, isError: true }]);
        },
    },
    {
        id: 'transcript.person-title',
        title: "reads a title the person gave as a title of the person's, with its text as written",
        features: ['tabs.title-status'],
        run: ({ port, world }) => {
            const title = titleOf(port.entry(world.title('login fixes')));
            assert.equal(title.by, 'person');
            assert.equal(title.text, 'login fixes');
        },
    },
    {
        id: 'transcript.only-named-kinds',
        title: 'gives no entry for a line that is none of the kinds asked for, and the entry for one that is',
        features: ['sessions.turn-end', 'sessions.carry', 'budget.helper-weight'],
        run: ({ port, world }) => {
            assert.equal(port.entry(world.reply(REPLY), ['input']), undefined);
            assert.equal(port.entry(world.prompt('Fix the login page', 'main'), ['reply', 'title']), undefined);
            assert.equal(kindOf(port.entry(world.reply(REPLY), ['reply'])), 'reply');
            assert.equal(kindOf(port.entry(world.prompt('Fix the login page', 'main'), ['title', 'input'])), 'input');
        },
    },
    {
        id: 'transcript.torn-line-unread',
        title: 'says a line cut off mid-write is unread, and never reads it as an entry or as nothing',
        features: ['sessions.turn-end', 'sessions.carry', 'tabs.title-status', 'budget.helper-weight'],
        run: ({ port, world }) => {
            assert.equal(kindOf(port.entry(world.torn())), 'unread');
        },
    },
    {
        id: 'transcript.blank-line-none',
        title: 'gives no entry for a blank line',
        features: ['sessions.turn-end'],
        run: ({ port }) => {
            assert.equal(port.entry(''), undefined);
            assert.equal(port.entry('  \r'), undefined);
        },
    },
    {
        id: 'transcript.unknown-line-other',
        title: 'reads a whole line of a kind it has no entry for as another kind, never as a prompt or a reply',
        features: ['sessions.turn-end', 'sessions.carry'],
        run: ({ port, world }) => {
            assert.equal(kindOf(port.entry(world.unknown())), 'other');
        },
    },
];
/** A world whose lines no reader could read: enough for a liar, which looks at none of them. */
const BLANK_WORLD = {
    prompt: (text) => `prompt ${text}`,
    reply: (reply) => `reply ${reply.text}`,
    result: (call, text) => `result ${call} ${text}`,
    title: (text) => `title ${text}`,
    unknown: () => 'unknown',
    torn: () => 'tor',
};
/** A liar that claims the port and reads nothing: every line is no entry. */
export function nothingTranscripts() {
    return { world: BLANK_WORLD, port: { entry: () => undefined } };
}
/** A liar that reads every line, whatever it holds and whatever kinds were asked for, as a prompt the person typed. */
export function yesTranscripts() {
    const read = (line) => ({
        kind: 'input',
        at: undefined,
        id: undefined,
        parent: undefined,
        session: undefined,
        thread: 'main',
        meta: false,
        job: undefined,
        text: line,
        parts: [],
        results: [],
        origin: undefined,
        turnOrigin: undefined,
        continuation: false,
        fromTool: false,
        background: undefined,
    });
    return { world: BLANK_WORLD, port: { entry: read } };
}
/** What every host's transcript reader must do with the lines its host writes. */
export const TRANSCRIPT_CONTRACT = defineContract({
    port: 'transcript',
    side: 'host',
    cases: CASES,
    liars: [nothingTranscripts, yesTranscripts],
});
