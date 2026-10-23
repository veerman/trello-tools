// Line-by-line comparison of two texts, for the side-by-side view (compare-view.js).
// Plain functions with no page code, so the Node tests can run them.

// What to ignore when deciding whether two lines are the same. Lines are always shown as written.
const DEFAULT_COMPARE_OPTIONS = { trailing: true, leading: true, spaces: false, blankLines: false, case: false };

// Past this many added plus removed lines, the rest of the texts counts as one big change,
// which keeps memory in check when two very different files are compared
const DIFF_MAX_EDITS = 3000;

const splitLines = (text) => {
    if (!text) return [];
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
};

// The text a line is compared by
const compareKey = (line, options) => {
    let key = line;
    if (options.trailing) key = key.replace(/\s+$/, '');
    if (options.leading) key = key.replace(/^\s+/, '');
    // Only runs between words, so indentation stays up to the leading option
    if (options.spaces) key = key.replace(/(\S)\s+(?=\S)/g, '$1 ');
    if (options.case) key = key.toLowerCase();
    return key;
};

// Shortest list of edits between two lists of strings (Myers' algorithm), as
// ['same', i, j], ['removed', i] and ['added', j], in order
const diffSequences = (a, b, maxEdits = DIFF_MAX_EDITS) => {
    const ops = [];
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) ops.push(['same', start, start++]);
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    const n = endA - start, m = endB - start, max = n + m;
    const v = new Int32Array(2 * max + 2);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= Math.min(max, maxEdits) && found < 0; d++) {
        trace.push(v.slice(max - d, max + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
            let y = x - k;
            while (x < n && y < m && a[start + x] === b[start + y]) { x++; y++; }
            v[max + k] = x;
            if (x >= n && y >= m) { found = d; break; }
        }
    }

    const middle = [];
    if (found < 0) {
        for (let i = start; i < endA; i++) middle.push(['removed', i]);
        for (let j = start; j < endB; j++) middle.push(['added', j]);
    } else {
        // Walk back from the end; trace[d] holds where each diagonal had reached before step d
        let x = n, y = m;
        for (let d = found; d > 0; d--) {
            const reached = (k) => trace[d][k + d];
            const k = x - y;
            const down = k === -d || (k !== d && reached(k - 1) < reached(k + 1));
            const prevK = down ? k + 1 : k - 1;
            const prevX = reached(prevK), prevY = prevX - prevK;
            while (x > prevX && y > prevY) { x--; y--; middle.push(['same', start + x, start + y]); }
            if (down) middle.push(['added', start + --y]);
            else middle.push(['removed', start + --x]);
        }
        while (x > 0 && y > 0) { x--; y--; middle.push(['same', start + x, start + y]); }
        middle.reverse();
    }
    for (const op of middle) ops.push(op);
    for (let k = 0; endA + k < a.length; k++) ops.push(['same', endA + k, endB + k]);
    return ops;
};

// Two texts in, rows for the side-by-side view out. Each row is { type, left, right }, with line
// indexes (or null for the side with nothing). Types: 'same'; 'changed' (both sides, different);
// 'removed' (left only); 'added' (right only); 'ignored' (a blank line on one side only, when
// blank lines are ignored). A run of removed lines is paired with the added lines next to it,
// so a changed line shows across from its new version.
const compareTexts = (leftText, rightText, options = DEFAULT_COMPARE_OPTIONS) => {
    const left = splitLines(leftText), right = splitLines(rightText);
    const counted = (lines) => lines.map((line, i) => i).filter(i => !(options.blankLines && lines[i].trim() === ''));
    const leftKept = counted(left), rightKept = counted(right);
    const ops = diffSequences(leftKept.map(i => compareKey(left[i], options)), rightKept.map(i => compareKey(right[i], options)));

    const pairs = [];
    let removed = [], added = [];
    const pairUp = () => {
        for (let k = 0; k < Math.max(removed.length, added.length); k++) {
            pairs.push([removed[k] ?? null, added[k] ?? null]);
        }
        removed = [];
        added = [];
    };
    for (const op of ops) {
        if (op[0] === 'same') { pairUp(); pairs.push([leftKept[op[1]], rightKept[op[2]]]); }
        else if (op[0] === 'removed') removed.push(leftKept[op[1]]);
        else added.push(rightKept[op[1]]);
    }
    pairUp();

    // Put the blank lines left out above back in place, side by side where both sides have one
    const rows = [];
    let nextLeft = 0, nextRight = 0;
    const blanksBefore = (l, r) => {
        const ls = [], rs = [];
        if (l !== null) while (nextLeft < l) ls.push(nextLeft++);
        if (r !== null) while (nextRight < r) rs.push(nextRight++);
        for (let k = 0; k < Math.max(ls.length, rs.length); k++) {
            const row = { left: ls[k] ?? null, right: rs[k] ?? null };
            rows.push({ type: row.left !== null && row.right !== null ? 'same' : 'ignored', ...row });
        }
    };
    for (const [l, r] of pairs) {
        blanksBefore(l, r);
        const sameKey = l !== null && r !== null && compareKey(left[l], options) === compareKey(right[r], options);
        rows.push({ type: sameKey ? 'same' : l === null ? 'added' : r === null ? 'removed' : 'changed', left: l, right: r });
        if (l !== null) nextLeft = l + 1;
        if (r !== null) nextRight = r + 1;
    }
    blanksBefore(left.length, right.length);

    // Differences: runs of rows that differ, for the summary and next/previous
    const blocks = [];
    const counts = { changed: 0, removed: 0, added: 0 };
    rows.forEach((row, i) => {
        if (!(row.type in counts)) return;
        counts[row.type]++;
        const last = blocks[blocks.length - 1];
        if (last && last.end === i) last.end = i + 1;
        else blocks.push({ start: i, end: i + 1 });
    });
    return { left, right, rows, blocks, counts, identical: left.join('\n') === right.join('\n') };
};

// The parts of two changed lines, word by word: { left, right }, each a list of [text, differs]
const DIFF_WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const inlineDiff = (leftLine, rightLine, options = DEFAULT_COMPARE_OPTIONS) => {
    const side = (line) => {
        const tokens = line.match(DIFF_WORD) || [];
        let start = 0, end = tokens.length;
        // Ignored spaces at either end never count as a difference
        if (options.leading && end > 0 && /^\s/.test(tokens[0])) start = 1;
        if (options.trailing && end > start && /^\s/.test(tokens[end - 1])) end--;
        const keys = tokens.slice(start, end).map((token, i) => {
            const inside = start + i > 0 && start + i < tokens.length - 1;
            if (options.spaces && inside && /^\s/.test(token)) return ' ';
            return options.case ? token.toLowerCase() : token;
        });
        return { tokens, start, end, keys, differs: tokens.map(() => false) };
    };
    const l = side(leftLine), r = side(rightLine);
    for (const op of diffSequences(l.keys, r.keys)) {
        if (op[0] === 'removed') l.differs[l.start + op[1]] = true;
        if (op[0] === 'added') r.differs[r.start + op[1]] = true;
    }
    const parts = ({ tokens, differs }) => {
        const out = [];
        tokens.forEach((token, i) => {
            const last = out[out.length - 1];
            if (last && last[1] === differs[i]) last[0] += token;
            else out.push([token, differs[i]]);
        });
        return out;
    };
    return { left: parts(l), right: parts(r) };
};
