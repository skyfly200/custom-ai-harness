// A chat can have several repos attached (ui/repos.js), the first one the default. Every repo_, github_ and
// run_command tool therefore takes an optional `repo`; the chat page resolves it to one of the attached repos
// and leaves it out (the default) most of the time.
'use strict';

/** The tool definitions with an optional `repo` argument added to each. `what` says what a value looks like. */
function withRepoArg(definitions, what) {
    return definitions.map((d) => ({
        ...d,
        function: {
            ...d.function,
            parameters: {
                ...d.function.parameters,
                properties: {
                    ...d.function.parameters.properties,
                    repo: { type: 'string', description: `Optional: the ${what} to use. Leave it out for the default (first) repo; name another only when the user asked for it` },
                },
            },
        },
    }));
}

module.exports = { withRepoArg };
