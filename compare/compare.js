// The Compare page: any two texts side by side. The view itself is ../shared/compare-view.js;
// this page adds the text boxes, Open, Clear, Swap, and dropping files.

// This tab's texts, so a reload keeps them
const TEXTS_KEY = 'trello_tools_compare_texts';
const DEFAULT_LABELS = { left: 'Left', right: 'Right' };

document.addEventListener('DOMContentLoaded', () => {
    const els = {
        main: document.getElementById('main'),
        editView: document.getElementById('edit-view'),
        diffView: document.getElementById('diff-view'),
        ruler: document.getElementById('ruler'),
        dropHint: document.getElementById('drop-hint'),
        summary: document.getElementById('summary'),
        swapBtn: document.getElementById('swap-btn'),
        modeBtn: document.getElementById('mode-btn'),
        headsRow: document.querySelector('.cmp-heads'),
        heads: { left: document.querySelector('.cmp-head[data-side="left"]'), right: document.querySelector('.cmp-head[data-side="right"]') },
        inputs: { left: document.getElementById('left-input'), right: document.getElementById('right-input') },
        files: { left: document.getElementById('file-left'), right: document.getElementById('file-right') }
    };

    const sides = { left: { label: DEFAULT_LABELS.left, text: '' }, right: { label: DEFAULT_LABELS.right, text: '' } };
    let mode = 'edit';
    let saveDebounce;

    // Double-click a line to edit it
    const view = new CompareView({
        scroller: els.diffView,
        rows: document.getElementById('rows'),
        ruler: els.ruler,
        summary: els.summary,
        prevBtn: document.getElementById('prev-btn'),
        nextBtn: document.getElementById('next-btn'),
        ignoreGroup: document.getElementById('ignore-group')
    }, { onLine: (side, line) => showEdit(side, line) });

    const saveTexts = () => {
        clearTimeout(saveDebounce);
        saveDebounce = setTimeout(() => {
            try { sessionStorage.setItem(TEXTS_KEY, JSON.stringify(sides)); } catch (e) { /* too big or blocked: not kept */ }
        }, 300);
    };

    const renderHead = (side) => {
        const lines = splitLines(sides[side].text).length;
        const label = CompareView.escape(sides[side].label);
        els.heads[side].innerHTML = `
            <span class="name" title="${label}">${label}</span>
            <span class="lines">${lines ? `${lines} line${lines === 1 ? '' : 's'}` : 'empty'}</span>
            <span class="actions">
                <button data-action="open" title="Open a file"><i class="fa-solid fa-folder-open"></i> Open</button>
                <button data-action="clear" title="Empty this side"${lines ? '' : ' disabled'}><i class="fa-solid fa-xmark"></i> Clear</button>
            </span>`;
    };

    const setSide = (side, text, label) => {
        sides[side] = { label: label || sides[side].label, text };
        els.inputs[side].value = text;
        renderHead(side);
        saveTexts();
    };

    const bothFilled = () => sides.left.text.trim() !== '' && sides.right.text.trim() !== '';

    const alignHeads = () => {
        els.headsRow.style.marginRight = mode === 'compare' ? `${view.rightEdge()}px` : '0';
    };

    // keepPlace: same texts, so stay where the reader is
    const showCompare = (keepPlace = false) => {
        mode = 'compare';
        els.editView.classList.add('hidden');
        els.diffView.classList.remove('hidden');
        els.ruler.classList.remove('hidden');
        els.modeBtn.innerHTML = '<i class="fa-solid fa-pen"></i> Edit';
        view.compare(sides.left.text, sides.right.text, { keepPlace });
        alignHeads();
    };

    // side and line: put the cursor on that line
    const showEdit = (side = null, line = 0) => {
        mode = 'edit';
        view.clear('');
        els.diffView.classList.add('hidden');
        els.ruler.classList.add('hidden');
        els.editView.classList.remove('hidden');
        els.modeBtn.innerHTML = '<i class="fa-solid fa-code-compare"></i> Compare';
        els.summary.textContent = bothFilled() ? 'Ready: Compare or Ctrl+Enter' : 'Put a text on each side to compare';
        alignHeads();
        const input = els.inputs[side || (sides.left.text.trim() ? 'right' : 'left')];
        input.focus();
        if (side) {
            const offset = sides[side].text.replace(/\r\n?/g, '\n').split('\n').slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
            input.setSelectionRange(offset, offset);
            input.scrollTop = Math.max(0, line * 20 - input.clientHeight / 3);
        }
    };

    const showBest = () => (bothFilled() ? showCompare() : showEdit());

    els.modeBtn.addEventListener('click', () => (mode === 'compare' ? showEdit() : showCompare()));
    els.swapBtn.addEventListener('click', () => {
        const { left, right } = sides;
        setSide('left', right.text, right.label);
        setSide('right', left.text, left.label);
        if (mode === 'compare') showCompare(true);
    });
    window.addEventListener('resize', alignHeads);

    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            if (mode === 'edit') showCompare();
            return;
        }
        if (mode !== 'compare' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
        if (e.key === 'n' || e.key === 'j') view.next();
        if (e.key === 'p' || e.key === 'k') view.previous();
    });

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
            els.summary.textContent = bothFilled() ? 'Ready: Compare or Ctrl+Enter' : 'Put a text on each side to compare';
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

    // --- Start with this tab's texts from before a reload ---
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(TEXTS_KEY)); } catch (e) { /* start empty */ }
    ['left', 'right'].forEach(side => {
        const text = saved && saved[side] && typeof saved[side].text === 'string' ? saved[side].text : '';
        setSide(side, text, saved && saved[side] ? String(saved[side].label || DEFAULT_LABELS[side]) : DEFAULT_LABELS[side]);
    });
    showBest();
});
