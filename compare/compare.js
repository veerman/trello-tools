// The Compare page: two texts side by side, with the differences marked line by line and word by word.
// The comparison itself is in diff.js.

// The Board Editor leaves its original and current text here when it opens this page
const HANDOFF_KEY = 'trello_tools_compare_handoff';
// This tab's texts, so a reload keeps them; the ignore choices, kept for next time
const TEXTS_KEY = 'trello_tools_compare_texts';
const OPTIONS_KEY = 'trello_tools_compare_ignore';

const IGNORE_CHOICES = [
    ['trailing', 'Trailing spaces', 'Spaces at the end of a line'],
    ['leading', 'Leading spaces', 'Indentation at the start of a line'],
    ['spaces', 'Extra spaces', 'Two or more spaces in a row between words'],
    ['blankLines', 'Blank lines', 'Empty lines added or removed'],
    ['case', 'Case', 'Capital and small letters']
];
const DEFAULT_LABELS = { left: 'Left', right: 'Right' };

const escapeHtml = (text) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Storage can be missing or blocked (private windows, blocked site data); the page works without it
const readStored = (area, key) => {
    try { return JSON.parse(area().getItem(key)); } catch (e) { return null; }
};
const writeStored = (area, key, value) => {
    try {
        if (value === null) area().removeItem(key);
        else area().setItem(key, JSON.stringify(value));
    } catch (e) { /* too big or blocked: nothing is kept */ }
};
const local = () => localStorage;
const session = () => sessionStorage;

document.addEventListener('DOMContentLoaded', () => {
    const els = {
        main: document.getElementById('main'),
        editView: document.getElementById('edit-view'),
        diffView: document.getElementById('diff-view'),
        rows: document.getElementById('rows'),
        ruler: document.getElementById('ruler'),
        dropHint: document.getElementById('drop-hint'),
        summary: document.getElementById('summary'),
        prevBtn: document.getElementById('prev-btn'),
        nextBtn: document.getElementById('next-btn'),
        swapBtn: document.getElementById('swap-btn'),
        modeBtn: document.getElementById('mode-btn'),
        ignoreGroup: document.getElementById('ignore-group'),
        headsRow: document.querySelector('.pane-heads'),
        heads: { left: document.querySelector('.pane-head[data-side="left"]'), right: document.querySelector('.pane-head[data-side="right"]') },
        inputs: { left: document.getElementById('left-input'), right: document.getElementById('right-input') },
        files: { left: document.getElementById('file-left'), right: document.getElementById('file-right') }
    };

    const sides = { left: { label: DEFAULT_LABELS.left, text: '' }, right: { label: DEFAULT_LABELS.right, text: '' } };
    let options = { ...DEFAULT_COMPARE_OPTIONS, ...(readStored(local, OPTIONS_KEY) || {}) };
    let mode = 'edit';
    let result = null;
    let current = -1;   // the difference picked with next/previous
    let saveDebounce;

    const saveTexts = () => {
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(() => writeStored(session, TEXTS_KEY, sides), 300);
    };

    // --- Pane headings ---
    const renderHead = (side) => {
        const lines = splitLines(sides[side].text).length;
        els.heads[side].innerHTML = `
            <span class="name" title="${escapeHtml(sides[side].label)}">${escapeHtml(sides[side].label)}</span>
            <span class="lines">${lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'empty'}</span>
            <span class="actions">
                <button data-action="open" title="Open a file"><i class="fa-solid fa-folder-open"></i> Open</button>
                <button data-action="clear" title="Empty this side"${lines ? '' : ' disabled'}><i class="fa-solid fa-xmark"></i> Clear</button>
            </span>`;
    };
    const renderHeads = () => { renderHead('left'); renderHead('right'); };

    const setSide = (side, text, label) => {
        sides[side] = { label: label || sides[side].label, text };
        els.inputs[side].value = text;
        renderHead(side);
        saveTexts();
    };

    const bothFilled = () => sides.left.text.trim() !== '' && sides.right.text.trim() !== '';

    // --- Ignore choices ---
    IGNORE_CHOICES.forEach(([key, label, hint]) => {
        const btn = document.createElement('button');
        btn.className = 'ignore-btn';
        btn.textContent = label;
        btn.title = `Ignore: ${hint}`;
        btn.setAttribute('aria-pressed', String(!!options[key]));
        btn.addEventListener('click', () => {
            options = { ...options, [key]: !options[key] };
            btn.setAttribute('aria-pressed', String(options[key]));
            writeStored(local, OPTIONS_KEY, options);
            if (mode === 'compare') showCompare(false);
        });
        els.ignoreGroup.appendChild(btn);
    });

    // --- Compare view ---
    const KINDS = { same: ['', ''], changed: ['del', 'ins'], removed: ['del', ''], added: ['', 'ins'], ignored: ['soft', 'soft'] };

    const cell = (side, index, kind, parts) => {
        if (index === null) return `<div class="num ${kind}"></div><div class="text ${kind}"></div>`;
        const text = parts
            ? parts.map(([part, differs]) => differs ? `<mark>${escapeHtml(part)}</mark>` : escapeHtml(part)).join('')
            : escapeHtml(result[side][index]);
        return `<div class="num ${kind}">${index + 1}</div><div class="text ${kind}" data-side="${side}" data-line="${index}">${text}</div>`;
    };

    const renderRows = () => {
        els.rows.innerHTML = result.rows.map((row, i) => {
            const [leftKind, rightKind] = KINDS[row.type];
            const gap = row.type === 'ignored' ? '' : 'empty';
            const parts = row.type === 'changed' ? inlineDiff(result.left[row.left], result.right[row.right], options) : null;
            return `<div class="row" id="row-${i}">`
                + cell('left', row.left, row.left === null ? gap : leftKind, parts && parts.left)
                + cell('right', row.right, row.right === null ? gap : rightKind, parts && parts.right)
                + '</div>';
        }).join('');
    };

    const renderSummary = () => {
        const n = result.blocks.length;
        if (!n) {
            els.summary.innerHTML = result.identical
                ? '<span class="text-green-400"><i class="fa-solid fa-check"></i> Identical</span>'
                : '<span class="text-green-400"><i class="fa-solid fa-check"></i> No differences</span> <span class="text-gray-500">apart from what is ignored</span>';
            return;
        }
        const { changed, removed, added } = result.counts;
        const count = (value, text, color) => value ? `<span class="${color}">${value} ${text}</span>` : '';
        els.summary.innerHTML = `<span class="text-white font-semibold">${current >= 0 ? `${current + 1} of ${n}` : n} difference${n === 1 ? '' : 's'}</span> `
            + [count(changed, 'changed', 'text-yellow-300'), count(removed, 'only left', 'text-red-300'), count(added, 'only right', 'text-green-300')]
                .filter(Boolean).join('<span class="text-gray-600"> · </span>');
    };

    const rowEl = (i) => document.getElementById(`row-${i}`);

    const drawRuler = () => {
        if (mode !== 'compare' || !result) return;
        const total = els.rows.scrollHeight || 1;
        els.ruler.innerHTML = result.blocks.map((block, i) => {
            const first = rowEl(block.start), last = rowEl(block.end - 1);
            const top = first.offsetTop / total * 100;
            const height = (last.offsetTop + last.offsetHeight - first.offsetTop) / total * 100;
            const types = result.rows.slice(block.start, block.end).map(row => row.type);
            const left = types.some(type => type !== 'added'), right = types.some(type => type !== 'removed');
            return `<div class="mark${i === current ? ' current' : ''}" data-block="${i}" style="top:${top}%;height:${height}%">`
                + (left ? '<i class="l"></i>' : '') + (right ? '<i class="r"></i>' : '') + '</div>';
        }).join('') + '<div class="window"></div>';
        moveWindow();
    };

    // The part of the file on screen, shown on the ruler
    const moveWindow = () => {
        const box = els.ruler.querySelector('.window');
        if (!box) return;
        const total = els.diffView.scrollHeight || 1;
        box.style.top = `${els.diffView.scrollTop / total * 100}%`;
        box.style.height = `${els.diffView.clientHeight / total * 100}%`;
    };

    // Line the pane headings up with the columns below, which stop short of the ruler and the scrollbar
    const alignHeads = () => {
        const gap = mode === 'compare' ? els.ruler.offsetWidth + els.diffView.offsetWidth - els.diffView.clientWidth : 0;
        els.headsRow.style.marginRight = `${gap}px`;
    };

    const updateNav = () => {
        const n = result && mode === 'compare' ? result.blocks.length : 0;
        els.prevBtn.disabled = els.nextBtn.disabled = n === 0;
        if (result && mode === 'compare') renderSummary();
        else els.summary.textContent = bothFilled() ? 'Ready: Compare or Ctrl+Enter' : 'Put a text on each side to compare';
    };

    const goTo = (index) => {
        if (!result || !result.blocks.length) return;
        const n = result.blocks.length;
        current = (index + n) % n;
        els.rows.querySelectorAll('.row.current').forEach(el => el.classList.remove('current'));
        els.ruler.querySelectorAll('.mark.current').forEach(el => el.classList.remove('current'));
        const block = result.blocks[current];
        for (let i = block.start; i < block.end; i++) rowEl(i).classList.add('current');
        const mark = els.ruler.querySelector(`.mark[data-block="${current}"]`);
        if (mark) mark.classList.add('current');
        els.diffView.scrollTo({ top: Math.max(0, rowEl(block.start).offsetTop - els.diffView.clientHeight / 3), behavior: 'smooth' });
        updateNav();
    };

    // fresh: new texts, so start at the first difference; otherwise keep the place (an ignore choice changed)
    const showCompare = (fresh = true) => {
        const scrollTop = els.diffView.scrollTop;
        result = compareTexts(sides.left.text, sides.right.text, options);
        current = -1;
        mode = 'compare';
        els.editView.classList.add('hidden');
        els.diffView.classList.remove('hidden');
        els.ruler.classList.remove('hidden');
        els.modeBtn.innerHTML = '<i class="fa-solid fa-pen"></i> Edit';
        renderRows();
        alignHeads();
        drawRuler();
        updateNav();
        if (!fresh) els.diffView.scrollTop = scrollTop;
        else if (result.blocks.length) goTo(0);
        else els.diffView.scrollTop = 0;
    };

    // side and line: put the cursor on that line (double-click in the compare view)
    const showEdit = (side = null, line = 0) => {
        mode = 'edit';
        result = null;
        els.diffView.classList.add('hidden');
        els.ruler.classList.add('hidden');
        els.editView.classList.remove('hidden');
        els.modeBtn.innerHTML = '<i class="fa-solid fa-code-compare"></i> Compare';
        alignHeads();
        updateNav();
        const input = els.inputs[side || (sides.left.text.trim() ? 'right' : 'left')];
        input.focus();
        if (side) {
            const offset = sides[side].text.replace(/\r\n?/g, '\n').split('\n').slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
            input.setSelectionRange(offset, offset);
            input.scrollTop = Math.max(0, line * 20 - input.clientHeight / 3);
        }
    };

    const showBest = () => (bothFilled() ? showCompare() : showEdit());

    // --- Toolbar ---
    els.modeBtn.addEventListener('click', () => (mode === 'compare' ? showEdit() : showCompare()));
    els.prevBtn.addEventListener('click', () => goTo(current < 0 ? -1 : current - 1));
    els.nextBtn.addEventListener('click', () => goTo(current + 1));
    els.swapBtn.addEventListener('click', () => {
        const { left, right } = sides;
        setSide('left', right.text, right.label);
        setSide('right', left.text, left.label);
        if (mode === 'compare') showCompare(false);
    });

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (mode === 'edit') showCompare();
            return;
        }
        if (mode !== 'compare' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        if (e.key === 'n' || e.key === 'j') goTo(current + 1);
        if (e.key === 'p' || e.key === 'k') goTo(current < 0 ? -1 : current - 1);
    });

    // --- Pane headings: Open and Clear ---
    ['left', 'right'].forEach(side => {
        els.heads[side].addEventListener('click', (e) => {
            const action = e.target.closest('button')?.dataset.action;
            if (action === 'open') els.files[side].click();
            if (action === 'clear') {
                setSide(side, '', DEFAULT_LABELS[side]);
                showEdit(side);
            }
        });
        els.files[side].addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            setSide(side, await file.text(), file.name);
            e.target.value = '';
            showBest();
        });
        els.inputs[side].addEventListener('input', () => {
            sides[side].text = els.inputs[side].value;
            renderHead(side);
            updateNav();
            saveTexts();
        });
        // Pasting into an empty side, with the other side filled, compares straight away
        els.inputs[side].addEventListener('paste', () => {
            const wasEmpty = !sides[side].text.trim();
            setTimeout(() => {
                if (wasEmpty && bothFilled()) showCompare();
            }, 0);
        });
    });

    // Double-click a line to edit it
    els.rows.addEventListener('dblclick', (e) => {
        const text = e.target.closest('.text[data-side]');
        if (text) showEdit(text.dataset.side, Number(text.dataset.line));
    });

    els.diffView.addEventListener('scroll', moveWindow);
    window.addEventListener('resize', () => {
        alignHeads();
        drawRuler();
    });
    els.ruler.addEventListener('click', (e) => {
        const mark = e.target.closest('.mark');
        if (mark) return goTo(Number(mark.dataset.block));
        const box = els.ruler.getBoundingClientRect();
        const share = (e.clientY - box.top) / box.height;
        els.diffView.scrollTop = share * els.diffView.scrollHeight - els.diffView.clientHeight / 2;
    });

    // --- Drop files: on the side they land on, or two at once to fill both ---
    const sideAt = (x) => {
        const box = els.main.getBoundingClientRect();
        return x < box.left + box.width / 2 ? 'left' : 'right';
    };
    window.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        els.dropHint.classList.remove('hidden');
        els.dropHint.style.left = sideAt(e.clientX) === 'left' ? '0' : '50%';
    });
    window.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget) els.dropHint.classList.add('hidden');
    });
    window.addEventListener('drop', async (e) => {
        els.dropHint.classList.add('hidden');
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        if (files.length >= 2) {
            setSide('left', await files[0].text(), files[0].name);
            setSide('right', await files[1].text(), files[1].name);
        } else {
            setSide(sideAt(e.clientX), await files[0].text(), files[0].name);
        }
        showBest();
    });

    // --- Start: texts from the Board Editor, or this tab's texts from before a reload ---
    const handoff = readStored(local, HANDOFF_KEY);
    if (handoff) writeStored(local, HANDOFF_KEY, null);
    const start = handoff || readStored(session, TEXTS_KEY) || {};
    ['left', 'right'].forEach(side => {
        const saved = start[side];
        if (saved && typeof saved.text === 'string') setSide(side, saved.text, String(saved.label || DEFAULT_LABELS[side]));
    });
    renderHeads();
    showBest();
});
