// The side-by-side view used by the Compare page and by Compare in the Board Editor. Both texts sit
// in one list of rows, so they stay lined up even when long lines wrap. Changed words are marked,
// a ruler shows where every difference is, and next/previous jump between them. The ignore
// choices are kept for next time. Needs diff.js; styles in compare.css.
class CompareView {
    // els: scroller (the scrolling box), rows (inside it), ruler, summary, prevBtn, nextBtn, ignoreGroup.
    // onLine(side, line) runs when a line is double-clicked.
    constructor(els, { onLine = null } = {}) {
        this.els = els;
        this.onLine = onLine;
        this.options = { ...DEFAULT_COMPARE_OPTIONS, ...CompareView.loadOptions() };
        this.texts = null;
        this.result = null;
        this.current = -1;
        this.showAll = false;   // true after Show all: no folded runs

        CompareView.IGNORE_CHOICES.forEach(([key, label, hint]) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cmp-ignore';
            btn.textContent = label;
            btn.title = `Ignore: ${hint}`;
            btn.setAttribute('aria-pressed', String(!!this.options[key]));
            btn.addEventListener('click', () => {
                this.options = { ...this.options, [key]: !this.options[key] };
                btn.setAttribute('aria-pressed', String(this.options[key]));
                CompareView.saveOptions(this.options);
                if (this.texts) this.compare(...this.texts, { keepPlace: true });
            });
            els.ignoreGroup.appendChild(btn);
        });

        els.prevBtn.addEventListener('click', () => this.previous());
        els.nextBtn.addEventListener('click', () => this.next());
        els.scroller.addEventListener('scroll', () => this.moveWindow());
        window.addEventListener('resize', () => this.drawRuler());
        els.ruler.addEventListener('click', (e) => {
            const mark = e.target.closest('.mark');
            if (mark) return this.goTo(Number(mark.dataset.block));
            const box = els.ruler.getBoundingClientRect();
            els.scroller.scrollTop = (e.clientY - box.top) / box.height * els.scroller.scrollHeight - els.scroller.clientHeight / 2;
        });
        els.rows.addEventListener('dblclick', (e) => {
            const text = e.target.closest('.text[data-side]');
            if (text && this.onLine) this.onLine(text.dataset.side, Number(text.dataset.line));
        });
        // A folded run opens on its own, or Show all opens every one until the next new comparison
        els.rows.addEventListener('click', (e) => {
            const btn = e.target.closest('.fold button');
            if (!btn) return;
            if (btn.dataset.unfold === 'all') {
                this.showAll = true;
                this.compare(...this.texts, { keepPlace: true });
                return;
            }
            const fold = btn.closest('.fold');
            for (let i = Number(fold.dataset.start); i < Number(fold.dataset.end); i++) this.rowEl(i).classList.remove('folded');
            fold.remove();
            this.drawRuler();
        });
        this.clear('');
    }

    // Draws the comparison. keepPlace: stay where the reader is (an ignore choice changed);
    // otherwise start at the first difference.
    compare(leftText, rightText, { keepPlace = false } = {}) {
        const scrollTop = this.els.scroller.scrollTop;
        if (!keepPlace) this.showAll = false;
        this.texts = [leftText, rightText];
        this.result = compareTexts(leftText, rightText, this.options);
        this.current = -1;
        this.renderRows();
        this.drawRuler();
        this.renderSummary();
        if (keepPlace) this.els.scroller.scrollTop = scrollTop;
        else if (this.result.blocks.length) this.goTo(0);
        else this.els.scroller.scrollTop = 0;
        return this.result;
    }

    // Nothing to compare yet: a message in place of the rows
    clear(message) {
        this.texts = null;
        this.result = null;
        this.current = -1;
        this.els.rows.innerHTML = message ? `<div class="cmp-message">${message}</div>` : '';
        this.els.ruler.innerHTML = '';
        this.els.summary.innerHTML = '';
        this.els.prevBtn.disabled = this.els.nextBtn.disabled = true;
    }

    renderRows() {
        const { result, options } = this;
        const cell = (side, index, kind, parts) => {
            if (index === null) return `<div class="num ${kind}"></div><div class="text ${kind}"></div>`;
            const text = parts
                ? parts.map(([part, differs]) => differs ? `<mark>${CompareView.escape(part)}</mark>` : CompareView.escape(part)).join('')
                : CompareView.escape(result[side][index]);
            return `<div class="num ${kind}">${index + 1}</div><div class="text ${kind}" data-side="${side}" data-line="${index}">${text}</div>`;
        };
        // Long runs of matching lines fold into one row that opens with a click
        const folds = this.showAll ? [] : foldRanges(result.rows);
        let nextFold = 0;
        this.els.rows.innerHTML = result.rows.map((row, i) => {
            const fold = folds[nextFold];
            const folded = fold && i >= fold.start && i < fold.end;
            const foldRow = fold && i === fold.start
                ? `<div class="fold" data-start="${fold.start}" data-end="${fold.end}">`
                    + `<button type="button" data-unfold="one"><i class="fa-solid fa-angles-down"></i> ${fold.end - fold.start} matching lines</button>`
                    + '<button type="button" data-unfold="all">Show all</button></div>'
                : '';
            if (fold && i === fold.end - 1) nextFold++;
            const [leftKind, rightKind] = CompareView.KINDS[row.type];
            // A blank line only on one side, when blank lines are ignored, gets a plain gap
            const gap = row.type === 'ignored' ? '' : 'empty';
            const parts = row.type === 'changed' ? inlineDiff(result.left[row.left], result.right[row.right], options) : null;
            return foldRow + `<div class="row${folded ? ' folded' : ''}" data-row="${i}">`
                + cell('left', row.left, row.left === null ? gap : leftKind, parts && parts.left)
                + cell('right', row.right, row.right === null ? gap : rightKind, parts && parts.right)
                + '</div>';
        }).join('');
    }

    renderSummary() {
        const { result, current } = this;
        const n = result.blocks.length;
        this.els.prevBtn.disabled = this.els.nextBtn.disabled = n === 0;
        if (!n) {
            this.els.summary.innerHTML = result.identical
                ? '<span class="text-teal-300"><i class="fa-solid fa-circle-check"></i> Identical</span>'
                : '<span class="text-teal-300"><i class="fa-solid fa-circle-check"></i> No differences</span> <span class="text-gray-500">apart from what is ignored</span>';
            return;
        }
        const { changed, removed, added } = result.counts;
        const count = (value, text, color) => value ? `<span class="${color}">${value} ${text}</span>` : '';
        this.els.summary.innerHTML = `<span class="text-white font-semibold">${current >= 0 ? `${current + 1} of ${n}` : n} difference${n === 1 ? '' : 's'}</span> `
            + [count(changed, 'changed', 'text-gray-200'), count(removed, 'only left', 'text-orange-300'), count(added, 'only right', 'text-blue-300')]
                .filter(Boolean).join('<span class="text-gray-600"> · </span>');
    }

    rowEl(i) {
        return this.els.rows.querySelector(`[data-row="${i}"]`);
    }

    // Marks on the ruler: orange for lines only on the left, blue for lines only on the right
    drawRuler() {
        const { result } = this;
        if (!result || !this.els.scroller.offsetHeight) return;
        const total = this.els.rows.scrollHeight || 1;
        this.els.ruler.innerHTML = result.blocks.map((block, i) => {
            const first = this.rowEl(block.start), last = this.rowEl(block.end - 1);
            const top = first.offsetTop / total * 100;
            const height = (last.offsetTop + last.offsetHeight - first.offsetTop) / total * 100;
            const types = result.rows.slice(block.start, block.end).map(row => row.type);
            const left = types.some(type => type !== 'added'), right = types.some(type => type !== 'removed');
            return `<div class="mark${i === this.current ? ' current' : ''}" data-block="${i}" style="top:${top}%;height:${height}%">`
                + (left ? '<i class="l"></i>' : '') + (right ? '<i class="r"></i>' : '') + '</div>';
        }).join('') + '<div class="window"></div>';
        this.moveWindow();
    }

    // The part of the file on screen, shown on the ruler
    moveWindow() {
        const box = this.els.ruler.querySelector('.window');
        if (!box) return;
        const total = this.els.scroller.scrollHeight || 1;
        box.style.top = `${this.els.scroller.scrollTop / total * 100}%`;
        box.style.height = `${this.els.scroller.clientHeight / total * 100}%`;
    }

    goTo(index) {
        const { result } = this;
        if (!result || !result.blocks.length) return;
        const n = result.blocks.length;
        this.current = (index + n) % n;
        this.els.rows.querySelectorAll('.row.current').forEach(el => el.classList.remove('current'));
        this.els.ruler.querySelectorAll('.mark.current').forEach(el => el.classList.remove('current'));
        const block = result.blocks[this.current];
        for (let i = block.start; i < block.end; i++) this.rowEl(i).classList.add('current');
        const mark = this.els.ruler.querySelector(`.mark[data-block="${this.current}"]`);
        if (mark) mark.classList.add('current');
        this.els.scroller.scrollTo({ top: Math.max(0, this.rowEl(block.start).offsetTop - this.els.scroller.clientHeight / 3), behavior: 'smooth' });
        this.renderSummary();
    }

    next() {
        this.goTo(this.current + 1);
    }

    previous() {
        this.goTo(this.current < 0 ? -1 : this.current - 1);
    }

    // Width taken on the right by the ruler and the scrollbar, so headings above can line up with the columns
    rightEdge() {
        return this.els.ruler.offsetWidth + this.els.scroller.offsetWidth - this.els.scroller.clientWidth;
    }

    static escape(text) {
        return text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // Storage can be missing or blocked (private windows, blocked site data); the view works without it
    static loadOptions() {
        try { return JSON.parse(localStorage.getItem(CompareView.OPTIONS_KEY)) || {}; } catch (e) { return {}; }
    }

    static saveOptions(options) {
        try { localStorage.setItem(CompareView.OPTIONS_KEY, JSON.stringify(options)); } catch (e) { /* not kept */ }
    }
}

CompareView.OPTIONS_KEY = 'trello_tools_compare_ignore';
CompareView.IGNORE_CHOICES = [
    ['trailing', 'Trailing spaces', 'Spaces at the end of a line'],
    ['leading', 'Leading spaces', 'Indentation at the start of a line'],
    ['spaces', 'Extra spaces', 'Two or more spaces in a row between words'],
    ['blankLines', 'Blank lines', 'Empty lines added or removed'],
    ['case', 'Case', 'Capital and small letters']
];
// Cell styles for each kind of row: [left, right]
CompareView.KINDS = { same: ['', ''], changed: ['del', 'ins'], removed: ['del', ''], added: ['', 'ins'], ignored: ['soft', 'soft'] };
