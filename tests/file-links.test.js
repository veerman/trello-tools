// Run: node tests/file-links.test.js
// Checks file-links/lookup.gs (the Apps Script lookup) with stand-ins for Google's services.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { run } = require('./helpers');

// A fresh script with a fake Sheet; returns the lookup and a counter of Sheet reads
const loadLookup = (rows, tabName = 'Links', cacheLimit = Infinity) => {
    const cacheStore = {};
    let sheetReads = 0;
    const sheet = { getDataRange: () => ({ getValues: () => { sheetReads++; return rows; } }) };
    const context = vm.createContext({
        SpreadsheetApp: {
            getActiveSpreadsheet: () => ({
                getSheetByName: (name) => name === tabName ? sheet : null,
                getSheets: () => [sheet]
            })
        },
        CacheService: { getScriptCache: () => ({
            get: (k) => cacheStore[k] || null,
            // Google refuses values over 100 KB
            put: (k, v) => { if (v.length > cacheLimit) throw new Error('Argument too large'); cacheStore[k] = v; }
        }) },
        ContentService: {
            MimeType: { JSON: 'application/json' },
            createTextOutput: (text) => ({ text, setMimeType(type) { this.type = type; return this; } })
        }
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'file-links', 'lookup.gs'), 'utf8'), context);
    const doGet = vm.runInContext('doGet', context);
    return {
        ask: (name) => {
            const output = doGet({ parameter: name === undefined ? {} : { f: name } });
            assert.strictEqual(output.type, 'application/json');
            return JSON.parse(output.text);
        },
        sheetReads: () => sheetReads
    };
};

const ROWS = [
    ['name', 'link'],
    ['Project Plan', 'https://drive.google.com/file/d/abc/view'],
    ['meeting_notes', 'https://drive.google.com/file/d/def/view'],
    ['sneaky', 'javascript:alert(1)'],
    ['', 'https://drive.google.com/file/d/nameless/view']
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a name finds its link, ignoring case, spaces, dashes, and underscores', () => {
    const lookup = loadLookup(ROWS);
    assert.deepStrictEqual(lookup.ask('project-plan'), { url: 'https://drive.google.com/file/d/abc/view' });
    assert.deepStrictEqual(lookup.ask(' PROJECT plan '), { url: 'https://drive.google.com/file/d/abc/view' });
    assert.deepStrictEqual(lookup.ask('Meeting Notes'), { url: 'https://drive.google.com/file/d/def/view' });
});

test('one answer at a time: unknown, empty, and missing names get no link', () => {
    const lookup = loadLookup(ROWS);
    assert.deepStrictEqual(lookup.ask('pitch deck'), { error: 'not found' });
    assert.deepStrictEqual(lookup.ask(''), { error: 'not found' });
    assert.deepStrictEqual(lookup.ask(undefined), { error: 'not found' });
});

test('only https links are ever handed out', () => {
    assert.deepStrictEqual(loadLookup(ROWS).ask('sneaky'), { error: 'not found' });
});

test('the Sheet is read once and then cached', () => {
    const lookup = loadLookup(ROWS);
    lookup.ask('project plan');
    lookup.ask('meeting notes');
    lookup.ask('pitch deck');
    assert.strictEqual(lookup.sheetReads(), 1);
});

test('a Sheet imported from a CSV works too: its first tab is read', () => {
    assert.deepStrictEqual(loadLookup(ROWS, 'links').ask('meeting notes'), { url: 'https://drive.google.com/file/d/def/view' });
});

test('a table too big for the cache still answers, from the Sheet', () => {
    const lookup = loadLookup(ROWS, 'Links', 10);
    assert.deepStrictEqual(lookup.ask('meeting notes'), { url: 'https://drive.google.com/file/d/def/view' });
    assert.deepStrictEqual(lookup.ask('project plan'), { url: 'https://drive.google.com/file/d/abc/view' });
});

test('the script asks Google only for access to its own spreadsheet', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'file-links', 'appsscript.json'), 'utf8'));
    assert.deepStrictEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets.currentonly']);
});

run(tests);
