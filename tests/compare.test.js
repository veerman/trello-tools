// Run: node tests/compare.test.js
// Checks the Compare page's line and word comparison (shared/diff.js).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { plain, run } = require('./helpers');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'diff.js'), 'utf8'), context);
const { compareTexts, inlineDiff, diffSequences, DEFAULT_COMPARE_OPTIONS } = vm.runInContext(
    '({ compareTexts, inlineDiff, diffSequences, DEFAULT_COMPARE_OPTIONS })', context);

const compare = (left, right, options = {}) => plain(compareTexts(left.join('\n'), right.join('\n'), { ...DEFAULT_COMPARE_OPTIONS, ...options }));
const types = (result) => result.rows.map(row => row.type);
const marked = (parts) => parts.filter(([, differs]) => differs).map(([text]) => text);

// Every line shows exactly once, in order, on its own side
const assertComplete = (result) => {
    for (const side of ['left', 'right']) {
        const shown = result.rows.map(row => row[side]).filter(i => i !== null);
        assert.deepStrictEqual(shown, result[side].map((line, i) => i), `${side} lines out of order or missing`);
    }
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('identical texts have no differences', () => {
    const result = compare(['# Board', '', '## List'], ['# Board', '', '## List']);
    assert.deepStrictEqual(types(result), ['same', 'same', 'same']);
    assert.strictEqual(result.blocks.length, 0);
    assert.ok(result.identical);
});

test('a changed line sits across from its new version, with the changed word marked', () => {
    const result = compare(['# Board', '### Kickoff meeting', 'end'], ['# Board', '### Kickoff workshop', 'end']);
    assert.deepStrictEqual(types(result), ['same', 'changed', 'same']);
    assert.deepStrictEqual(result.blocks, [{ start: 1, end: 2 }]);
    const parts = plain(inlineDiff('### Kickoff meeting', '### Kickoff workshop'));
    assert.deepStrictEqual(marked(parts.left), ['meeting']);
    assert.deepStrictEqual(marked(parts.right), ['workshop']);
    assert.strictEqual(parts.left.map(([text]) => text).join(''), '### Kickoff meeting');
});

test('lines on one side only line up against a gap on the other', () => {
    const result = compare(['a', 'b', 'c', 'd'], ['a', 'c', 'x', 'd']);
    assert.deepStrictEqual(result.rows.map(row => [row.type, row.left, row.right]), [
        ['same', 0, 0], ['removed', 1, null], ['same', 2, 1], ['added', null, 2], ['same', 3, 3]
    ]);
    assert.deepStrictEqual(result.counts, { changed: 0, removed: 1, added: 1 });
    assert.strictEqual(result.blocks.length, 2);
});

test('spaces at the end of a line are ignored by default, and shown when that is turned off', () => {
    assert.strictEqual(compare(['- item  '], ['- item']).blocks.length, 0);
    const strict = compare(['- item  '], ['- item'], { trailing: false });
    assert.deepStrictEqual(types(strict), ['changed']);
    assert.deepStrictEqual(marked(plain(inlineDiff('- item  ', '- item', { trailing: false })).left), ['  ']);
});

test('leading spaces are ignored by default, and count when that is turned off', () => {
    assert.strictEqual(compare(['    text'], ['  text']).blocks.length, 0);
    assert.deepStrictEqual(marked(plain(inlineDiff('    text', '  text')).left), []);
    assert.strictEqual(compare(['    text'], ['  text'], { leading: false }).blocks.length, 1);
    assert.deepStrictEqual(marked(plain(inlineDiff('    text', '  text', { ...DEFAULT_COMPARE_OPTIONS, leading: false })).left), ['    ']);
});

test('extra spaces inside a line can be ignored without ignoring indentation', () => {
    assert.strictEqual(compare(['a  b'], ['a b']).blocks.length, 1);
    assert.strictEqual(compare(['a  b'], ['a b'], { spaces: true }).blocks.length, 0);
    assert.strictEqual(compare(['    a  b'], ['a b'], { spaces: true, leading: false }).blocks.length, 1);
    assert.deepStrictEqual(marked(plain(inlineDiff('a  b c', 'a b d', { ...DEFAULT_COMPARE_OPTIONS, spaces: true })).left), ['c']);
});

test('ignored blank lines stay in place without counting as differences', () => {
    const left = ['# Board', '', '', '## List', 'card'];
    const right = ['# Board', '## List', '', 'card'];
    assert.ok(compare(left, right).blocks.length > 0);
    const result = compare(left, right, { blankLines: true });
    assert.strictEqual(result.blocks.length, 0);
    assert.ok(types(result).includes('ignored'));
    assertComplete(result);
    // A real change next to blank lines still shows, and blanks don't pair with text
    const changed = compare(['a', '', 'b'], ['a', 'B2'], { blankLines: true });
    assert.deepStrictEqual(changed.rows.map(row => [row.type, row.left, row.right]), [
        ['same', 0, 0], ['ignored', 1, null], ['changed', 2, 1]
    ]);
});

test('case can be ignored', () => {
    assert.strictEqual(compare(['Done'], ['done']).blocks.length, 1);
    assert.strictEqual(compare(['Done'], ['done'], { case: true }).blocks.length, 0);
});

test('Windows line endings and a final newline are not differences', () => {
    const result = plain(compareTexts('a\r\nb\r\n', 'a\nb', DEFAULT_COMPARE_OPTIONS));
    assert.strictEqual(result.blocks.length, 0);
    assert.ok(result.identical);
    assert.deepStrictEqual(plain(compareTexts('', '', DEFAULT_COMPARE_OPTIONS)).rows, []);
    assert.deepStrictEqual(types(plain(compareTexts('', 'x', DEFAULT_COMPARE_OPTIONS))), ['added']);
});

test('the fewest possible lines are marked, checked against a slow exact count', () => {
    const lcs = (a, b) => {
        const t = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
        for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
            t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
        }
        return t[0][0];
    };
    let seed = 7;
    const random = (n) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let round = 0; round < 300; round++) {
        const a = Array.from({ length: random(12) }, () => 'abcd'[random(4)]);
        const b = Array.from({ length: random(12) }, () => 'abcd'[random(4)]);
        const ops = plain(diffSequences(a, b));
        const same = ops.filter(op => op[0] === 'same');
        assert.ok(same.every(([, i, j]) => a[i] === b[j]));
        assert.strictEqual(same.length, lcs(a, b), `${a.join('')} vs ${b.join('')}`);
        assert.strictEqual(ops.filter(op => op[0] === 'removed').length, a.length - same.length);
        assert.strictEqual(ops.filter(op => op[0] === 'added').length, b.length - same.length);
        assertComplete(compare(a, b));
    }
});

test('a large board with one change is quick, and two unrelated files still show every line', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `- card ${i}`);
    const edited = big.slice();
    edited[2500] = '- card 2500 (moved)';
    const started = Date.now();
    const result = compare(big, edited);
    assert.ok(Date.now() - started < 1000);
    assert.deepStrictEqual(result.blocks, [{ start: 2500, end: 2501 }]);

    const other = Array.from({ length: 4000 }, (_, i) => `other ${i}`);
    const apart = compare(big, other);
    assertComplete(apart);
    assert.strictEqual(apart.counts.changed, 4000);
});

run(tests);
