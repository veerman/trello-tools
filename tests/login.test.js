// Run: node tests/login.test.js
// Checks shared/trello.js (API key, login, Disconnect, API calls) with a fake browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { run } = require('./helpers');

const KEY = '0123456789abcdef0123456789abcdef';

// A fresh fake browser for each test: storage, address bar, history, and fetch
const loadShared = (href, responses = []) => {
    const store = {};
    const page = { href, reloaded: false, replacedWith: null, requests: [], waits: [] };
    const context = vm.createContext({
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
        },
        // Like a browser: the address bar changes, without loading the page again
        history: { replaceState: (state, title, url) => { page.replacedWith = url; page.href = new URL(url, page.href).href; } },
        // Waits are recorded, not waited out
        setTimeout: (fn, ms) => { page.waits.push(ms); fn(); },
        window: {
            location: {
                get href() { return page.href; },
                set href(value) { page.href = value; },
                get hash() { return page.href.includes('#') ? page.href.slice(page.href.indexOf('#')) : ''; },
                get pathname() { return new URL(page.href).pathname; },
                get search() { return new URL(page.href).search; },
                reload: () => { page.reloaded = true; }
            },
            fetch: async (url, options = {}) => {
                page.requests.push({ url, method: options.method || 'GET', headers: options.headers || {} });
                const next = responses.shift() || { status: 200, body: '{}' };
                return { ok: next.status < 400, status: next.status, text: async () => next.body, json: async () => JSON.parse(next.body) };
            }
        },
        URL,
        URLSearchParams
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'trello.js'), 'utf8'), context);
    return { trello: vm.runInContext('trello', context), store, page };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('init picks up the token from Connect and clears the old per-page tokens', () => {
    const { trello, store, page } = loadShared('http://localhost:8000/board-editor/?view=board#token=ABC123');
    store.trello_tools_api_key = KEY;
    store.trello_oauth_token = 'old1';
    store.trello_org_token = 'old2';
    assert.strictEqual(trello.init(), 'ABC123');
    assert.strictEqual(store.trello_tools_token, 'ABC123');
    assert.ok(!('trello_oauth_token' in store) && !('trello_org_token' in store));
    assert.strictEqual(page.replacedWith, '/board-editor/?view=board');
});

test('a token without an API key does not count as connected', () => {
    const { trello, store } = loadShared('https://example.github.io/trello-tools/board-editor/');
    store.trello_tools_token = 'ABC123';
    assert.strictEqual(trello.init(), '');
});

test('authorize saves the key and keeps the page address, ?url= and all, as the return address', () => {
    const { trello, store, page } = loadShared('https://example.github.io/trello-tools/board-editor/?url=https://example.com/b.md&view=board');
    trello.authorize(KEY);
    assert.strictEqual(store.trello_tools_api_key, KEY);
    const params = new URL(page.href).searchParams;
    assert.strictEqual(params.get('key'), KEY);
    assert.strictEqual(params.get('return_url'), 'https://example.github.io/trello-tools/board-editor/?url=https://example.com/b.md&view=board');
    assert.strictEqual(params.get('scope'), 'read,write,account');
});

test('the paste-a-token page has no return address, and a pasted token is saved', () => {
    const { trello, store, page } = loadShared('file:///C:/trello-tools/board-editor/index.html');
    assert.strictEqual(new URL(trello.authorizeUrl(KEY, false)).searchParams.get('return_url'), null);
    trello.useToken(KEY, 'PASTED');
    assert.strictEqual(store.trello_tools_api_key, KEY);
    assert.strictEqual(store.trello_tools_token, 'PASTED');
    assert.ok(page.reloaded);
});

test('only 32 letters and numbers pass as an API key', () => {
    const { trello } = loadShared('http://localhost:8000/');
    assert.ok(trello.isValidKey(KEY));
    assert.ok(!trello.isValidKey(KEY.slice(1)));
    assert.ok(!trello.isValidKey('ATTA' + KEY));
    assert.ok(!trello.isValidKey(''));
});

test('disconnect revokes the token at Trello, forgets it, keeps the key, and reloads', async () => {
    const { trello, store, page } = loadShared('http://localhost:8000/member-tools/');
    store.trello_tools_api_key = KEY;
    store.trello_tools_token = 'ABC123';
    await trello.disconnect();
    assert.strictEqual(page.requests[0].method, 'DELETE');
    assert.strictEqual(page.requests[0].url, `https://api.trello.com/1/tokens/ABC123?key=${KEY}&token=ABC123`);
    assert.ok(!('trello_tools_token' in store));
    assert.strictEqual(store.trello_tools_api_key, KEY);
    assert.ok(page.reloaded);
});

test('fetch uses the saved key and token, and JSON headers when there is a body', async () => {
    const { trello, store, page } = loadShared('http://localhost:8000/', [{ status: 200, body: '{"id":"x"}' }]);
    store.trello_tools_api_key = KEY;
    store.trello_tools_token = 'ABC123';
    const result = await trello.fetch('cards?pos=top', { method: 'POST', body: '{}' });
    assert.strictEqual(result.id, 'x');
    assert.strictEqual(page.requests[0].url, `https://api.trello.com/1/cards?pos=top&key=${KEY}&token=ABC123`);
    assert.strictEqual(page.requests[0].headers['Content-Type'], 'application/json');
});

test('a revoked login is forgotten so the page offers Connect again', async () => {
    const { trello, store } = loadShared('http://localhost:8000/', [
        { status: 401, body: 'unauthorized card permission requested' },
        { status: 401, body: 'invalid token' }
    ]);
    store.trello_tools_api_key = KEY;
    store.trello_tools_token = 'ABC123';
    await assert.rejects(trello.fetch('cards/1'));
    assert.strictEqual(store.trello_tools_token, 'ABC123');
    await assert.rejects(trello.fetch('members/me'));
    assert.ok(!('trello_tools_token' in store));
});

test('a shared ?api_key= link saves the key, drops a login made with another key, and leaves the address', () => {
    const { trello, store, page } = loadShared(`https://example.github.io/trello-tools/board-editor/?api_key=${KEY}&view=board`);
    store.trello_tools_api_key = 'f'.repeat(32);
    store.trello_tools_token = 'OLD';
    assert.strictEqual(trello.init(), '');
    assert.strictEqual(store.trello_tools_api_key, KEY);
    assert.ok(!('trello_tools_token' in store), 'a login belongs to the key it was made with');
    assert.strictEqual(page.replacedWith, '/trello-tools/board-editor/?view=board');
});

test('the same key again keeps the login; a malformed key is ignored but still leaves the address', () => {
    const same = loadShared(`http://localhost:8000/board-editor/?api_key=${KEY}`);
    same.store.trello_tools_api_key = KEY;
    same.store.trello_tools_token = 'ABC123';
    assert.strictEqual(same.trello.init(), 'ABC123');
    assert.strictEqual(same.page.replacedWith, '/board-editor/');

    const bad = loadShared('http://localhost:8000/member-tools/?api_key=<script>&x=1');
    assert.strictEqual(bad.trello.init(), '');
    assert.ok(!('trello_tools_api_key' in bad.store));
    assert.strictEqual(bad.page.replacedWith, '/member-tools/?x=1');
});

test('the key link and the token from Connect work together', () => {
    const { trello, store, page } = loadShared(`http://localhost:8000/board-editor/?api_key=${KEY}#token=NEW`);
    assert.strictEqual(trello.init(), 'NEW');
    assert.strictEqual(store.trello_tools_api_key, KEY);
    assert.strictEqual(page.href, 'http://localhost:8000/board-editor/');
});

test('"too many requests" waits and sends the same request again instead of failing', async () => {
    const { trello, store, page } = loadShared('http://localhost:8000/', [
        { status: 429, body: 'API_TOKEN_LIMIT_EXCEEDED' },
        { status: 429, body: 'API_TOKEN_LIMIT_EXCEEDED' },
        { status: 200, body: '{"id":"card1"}' }
    ]);
    store.trello_tools_api_key = KEY;
    store.trello_tools_token = 'ABC123';
    const paused = [];
    trello.onPause = (seconds) => paused.push(seconds);
    const result = await trello.fetch('cards?idList=L1', { method: 'POST', body: '{"name":"Kickoff"}' });
    assert.strictEqual(result.id, 'card1');
    assert.strictEqual(page.requests.length, 3);
    assert.ok(page.requests.every(r => r.method === 'POST' && r.url === page.requests[0].url));
    assert.deepStrictEqual(paused, [10, 20]);
    assert.deepStrictEqual(page.waits, [10000, 20000]);
});

test('if Trello keeps refusing, it gives up after about three minutes with the error', async () => {
    const { trello, store, page } = loadShared('http://localhost:8000/', Array(10).fill({ status: 429, body: 'API_KEY_LIMIT_EXCEEDED' }));
    store.trello_tools_api_key = KEY;
    store.trello_tools_token = 'ABC123';
    await assert.rejects(trello.fetch('members/me'), /429/);
    assert.strictEqual(page.requests.length, 7);
    assert.strictEqual(page.waits.reduce((a, b) => a + b, 0), 150000);
});

run(tests);
