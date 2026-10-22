// npm run hash [password]: print a hash for HARNESS_ADMINS. Without an argument it
// asks, so the password stays out of your shell history.
const readline = require('readline');
const { hashPassword, MIN_PASSWORD } = require('../utils/users');

function ask(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
        if (process.stdin.isTTY) {
            // hide what is typed
            rl._writeToOutput = (s) => { if (s.includes(question)) process.stderr.write(s); };
        }
        rl.question(question, (answer) => { rl.close(); if (process.stdin.isTTY) process.stderr.write('\n'); resolve(answer); });
    });
}

(async () => {
    const password = process.argv[2] ?? await ask('Password: ');
    if (password.length < MIN_PASSWORD) {
        console.error(`Use at least ${MIN_PASSWORD} characters.`);
        process.exit(1);
    }
    console.log(hashPassword(password));
    console.error('Put it in .env as HARNESS_ADMINS=name:HASH (several: name:HASH,name2:HASH2).');
})();
