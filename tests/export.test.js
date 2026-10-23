// Run: node tests/export.test.js
// Checks the editor's exporter and parser against tests/fixtures without a browser.
const assert = require('assert');
const { fixture, loadEditor, plain, run } = require('./helpers');

const { boardToMarkdown, parseMarkdownToData, escapeHtml, safeUrl } = loadEditor();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('export matches fixtures/board.md', () => {
    assert.strictEqual(boardToMarkdown(JSON.parse(fixture('board.json'))), fixture('board.md'));
});

test('the backup file parses the same as the editor file (comments are skipped)', () => {
    const fromBackup = JSON.stringify(parseMarkdownToData(fixture('board-backup.md')));
    assert.strictEqual(fromBackup, JSON.stringify(parseMarkdownToData(fixture('board.md'))));
    assert.ok(!fromBackup.includes('Looks good'));
});

test('parse keeps what Save to Trello needs', () => {
    const data = plain(parseMarkdownToData(fixture('board.md')));
    assert.strictEqual(data.name, 'Sample Board');
    assert.deepStrictEqual(data.lists.map(l => l.name), ['Week 1', 'Week 2', 'Empty list']);

    const [priority, kickoff] = data.lists[0].cards;
    assert.deepStrictEqual([priority.name, priority.color], ['Priority [red]', null]);
    assert.deepStrictEqual([kickoff.name, kickoff.color], ['Kickoff:', 'green']);
    assert.strictEqual(kickoff.desc.join('\n').trim(), 'Welcome!\n\nRead the plan.');

    const research = data.lists[1].cards[0];
    assert.deepStrictEqual(research.checklists, [{ name: 'Tasks', items: [
        { name: 'Book call', checked: true },
        { name: 'Write notes', checked: false }
    ] }]);
    assert.deepStrictEqual(research.attachments, [
        { name: 'Plan [v2].docx', url: 'https://trello.com/1/cards/C5/attachments/A1/download/Plan_v2.docx' },
        { name: 'Site (beta)', url: 'https://example.com/page_%28beta%29' }
    ]);
});

test('the front matter block is read as board details, not board content', () => {
    const data = plain(parseMarkdownToData(fixture('board.md')));
    assert.deepStrictEqual(data.meta, {
        trello_board: '65a1b2c3d4e5f6a7b8c9d0e1',
        url: 'https://trello.com/b/AbCd1234',
        workspace: 'Sample Workspace',
        created: '2024-01-12',
        last_activity: '2026-01-03'
    });
    assert.strictEqual(data.name, 'Sample Board');
    // Without a closing --- line it is not front matter
    assert.deepStrictEqual(plain(parseMarkdownToData('---\nnot: closed\n# B\n')).meta, {});
});

test('a fingerprint after an attachment link is not part of the link', () => {
    const data = plain(parseMarkdownToData('# B\n\n## L\n\n### C\n\n##### Attachments\n- [Plan.docx](https://trello.com/1/cards/c/attachments/a/download/Plan.docx "sha256:3f2a9c1b7d4e5a60")\n'));
    assert.deepStrictEqual(data.lists[0].cards[0].attachments, [
        { name: 'Plan.docx', url: 'https://trello.com/1/cards/c/attachments/a/download/Plan.docx' }
    ]);
});

test('checklist ticks: [x], [X], [ ] and plain items', () => {
    const data = plain(parseMarkdownToData('# B\n\n## L\n\n### C\n\n#### T\n- [x] a\n- [X] b\n- [ ] c\n- d\n'));
    assert.deepStrictEqual(data.lists[0].cards[0].checklists[0].items.map(i => [i.name, i.checked]),
        [['a', true], ['b', true], ['c', false], ['d', false]]);
});

test('escapeHtml and safeUrl block injected code', () => {
    assert.strictEqual(escapeHtml(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
    assert.strictEqual(safeUrl('javascript:alert(1)'), '#');
    assert.strictEqual(safeUrl('java\tscript:alert(1)'), '#');
    assert.strictEqual(safeUrl(' JavaScript:alert(1)'), '#');
    assert.strictEqual(safeUrl('data:text/html,hi'), '#');
    assert.strictEqual(safeUrl('https://example.com/a'), 'https://example.com/a');
    assert.strictEqual(safeUrl('mailto:a@example.com'), 'mailto:a@example.com');
    assert.strictEqual(safeUrl('notes/file.md'), 'notes/file.md');
});

run(tests);
