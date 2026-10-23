// Run: node tests/check.test.js
// Checks the board check that runs before Save to Trello.
const assert = require('assert');
const { fixture, loadEditor, plain, run } = require('./helpers');

const { checkBoardMarkdown, summarizeCheck, formatCheckReport } = loadEditor();
const check = (markdown, original = null) => plain(checkBoardMarkdown(markdown, original));
const has = (items, prefix, text) => items.some(item => item.startsWith(prefix) && item.includes(text));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('exports from both tools pass with nothing to report', () => {
    const board = fixture('board.md');
    assert.strictEqual(summarizeCheck(check(board, board)), 'Ready to save');
    assert.strictEqual(summarizeCheck(check(fixture('board-backup.md'), board)), 'Ready to save');
});

test('problems: attachments Trello would reject, and nothing to create', () => {
    const result = check([
        '# B', '', '## L', '', '### C', '', '##### Attachments',
        '- just some text',
        '- [Deck](slides.pptx)',
        '- [Site](https://example.com)'
    ].join('\n'));
    assert.ok(has(result.problems, 'Line 8:', 'is not a link'));
    assert.ok(has(result.problems, 'Line 9:', 'must start with http'));
    assert.strictEqual(result.problems.length, 2);
    assert.ok(has(check('# Just a title').problems, '', 'add at least one ## list'));
    assert.ok(has(check('').problems, '', 'add at least one ## list'));
});

test('problems: description over the Trello limit', () => {
    const result = check(`# B\n\n## L\n\n### C\n\n${'x'.repeat(16385)}\n`);
    assert.ok(has(result.problems, 'Card "C"', '16,384'));
});

test('warnings: content Save to Trello would ignore', () => {
    const result = check([
        '# B',                       // 1
        'Board notes',               // 2: before the first list
        '## L',                      // 3
        'List notes',                // 4: before the first card
        '### Card [white]',          // 5: not a colour
        '#### Tasks',                // 6
        '- one',                     // 7
        '+ two',                     // 8: not a - item
        '##### Links',               // 9: unknown heading
        '# Goal'                     // 10: second title
    ].join('\n'));
    assert.ok(has(result.warnings, 'Line 2:', 'before the first list'));
    assert.ok(has(result.warnings, 'Line 4:', 'between a list and its first card'));
    assert.ok(has(result.warnings, 'Line 5:', '[white] is not a cover colour'));
    assert.ok(has(result.warnings, 'Line 8:', 'only "- " items'));
    assert.ok(has(result.warnings, 'Line 9:', 'not a heading the editor knows'));
    assert.ok(has(result.warnings, 'Line 10:', 'second # title'));
    assert.strictEqual(result.warnings.length, 6);
    assert.strictEqual(result.problems.length, 0);
});

test('warnings: cards and checklists outside where they belong', () => {
    const result = check('# B\n\n### Orphan\n\n## L\n\n#### Loose checklist\n');
    assert.ok(has(result.warnings, 'Line 3:', '(Unlisted)'));
    assert.ok(has(result.warnings, 'Line 7:', 'not inside a card'));
});

test('fingerprinted attachment links pass the check', () => {
    const result = check('# B\n\n## L\n\n### C\n\n##### Attachments\n- [Plan.docx](https://example.com/Plan.docx "sha256:3f2a9c1b7d4e5a60")\n');
    assert.strictEqual(result.problems.length + result.warnings.length, 0);
});

test('a bracketed word kept in the title with [] is fine', () => {
    assert.strictEqual(check('# B\n\n## L\n\n### Plan [Draft] []\n').warnings.length, 0);
});

test('changes: renamed, removed, new, moved cards and lost attachments', () => {
    const original = fixture('board.md');
    const edited = original
        .replace('### Kickoff: [green]', '### Kick-off [green]')
        .replace('### Priority [red] []\n\n', '')
        .replace('- [Site (beta)](https://example.com/page_%28beta%29)\n', '')
        .replace('- Write notes\n', '')
        .replace('Find three experts.', 'Find five experts.')
        .replace('## Empty list\n', '## Empty list\n\n### Wrap-up []\n');
    const { changes } = check(edited, original);
    assert.deepStrictEqual(changes, [
        'Removed card: "Priority [red]" (Week 1)',
        'Renamed? "Kickoff:" is now "Kick-off" (Week 1)',
        'New card: "Wrap-up" (Empty list)',
        'Removed attachment: "Site (beta)" from "Research"',
        'Fewer checklist items: "Research" went from 2 to 1',
        '1 card description changed'
    ]);

    const badTag = original.replace('### Kickoff: [green]', '### Kick-off [white]');
    assert.deepStrictEqual(check(badTag, original).changes, ['Renamed? "Kickoff:" is now "Kick-off [white]" (Week 1)']);

    const moved = original.replace('### Kickoff: [green]\n\nWelcome!\n\nRead the plan.\n\n', '')
        .replace('## Empty list\n', '## Empty list\n\n### Kickoff: [green]\n\nWelcome!\n\nRead the plan.\n');
    assert.deepStrictEqual(check(moved, original).changes, ['Moved: "Kickoff:" from Week 1 to Empty list']);
});

test('the copied report lists everything in plain text', () => {
    const report = formatCheckReport(check('# B\n\n## L\n\n### C\n\n##### Attachments\n- nope\n'), 'B from Trello');
    assert.ok(report.startsWith('Problems (fix these before saving):\n- Line 8: attachment "nope" is not a link.'));
    assert.strictEqual(formatCheckReport(check(fixture('board.md')), 'x'), 'No problems found.');
});

run(tests);
