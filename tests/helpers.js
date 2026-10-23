// Shared setup for the Node tests: loads shared/trello.js and board-editor/script.js without a browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').replace(/\r\n/g, '\n');

// script.js is a plain browser script, so run it in a sandbox and pull out the top-level functions
const loadEditor = () => {
    const context = vm.createContext({ document: { addEventListener() {} } });
    for (const file of [['shared', 'trello.js'], ['board-editor', 'script.js']]) {
        vm.runInContext(fs.readFileSync(path.join(root, ...file), 'utf8'), context);
    }
    return vm.runInContext(`({ boardToMarkdown, parseMarkdownToData, escapeHtml, safeUrl,
        checkBoardMarkdown, summarizeCheck, formatCheckReport })`, context);
};

// Objects made inside the sandbox have their own prototypes, so compare plain copies
const plain = (value) => JSON.parse(JSON.stringify(value));

const run = async (tests) => {
    let failed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log(`ok   ${name}`);
        } catch (e) {
            failed++;
            console.log(`FAIL ${name}\n${e.message}`);
        }
    }
    console.log(`\n${tests.length - failed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
};

module.exports = { fixture, loadEditor, plain, run };
