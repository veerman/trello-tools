// Run: node tests/css.test.js
// Checks shared/tailwind.css has every Tailwind class the pages use, so a class added without
// rebuilding the styles can't go unstyled. When it fails, run: npm run css
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { run } = require('./helpers');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const list = (dir, pattern) => fs.readdirSync(path.join(root, dir)).filter(name => pattern.test(name)).map(name => `${dir}/${name}`);

// The same files tailwind.config.js builds from
const pages = [...list('board-editor', /\.(html|js)$/), ...list('member-tools', /\.html$/), ...list('compare', /\.(html|js)$/), ...list('shared', /\.js$/)];
const css = read('shared/tailwind.css');

// Our own classes: defined in our stylesheets, or used by the scripts to find elements
const ownClasses = new Set();
for (const file of [...list('board-editor', /\.css$/), ...list('compare', /\.css$/), 'shared/compare.css', ...pages]) {
    const text = read(file);
    const styles = file.endsWith('.css') ? [text] : [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
    styles.forEach(style => [...style.matchAll(/\.([a-zA-Z_][\w-]*)/g)].forEach(m => ownClasses.add(m[1])));
    [...text.matchAll(/(?:querySelector(?:All)?|closest|matches)\(\s*[`'"]([^`'"]*)[`'"]/g)]
        .forEach(m => [...m[1].matchAll(/\.([a-zA-Z_][\w-]*)/g)].forEach(c => ownClasses.add(c[1])));
}

// Words in script strings that look like Tailwind utilities (ids and other strings don't)
const UTILITY = new RegExp('^(?:[a-z-]+:)*-?(?:'
    // always with a value: bg-gray-800, p-4, w-full
    + '(?:bg|text|font|leading|tracking|opacity|z|gap|space-[xy]|divide|grid-cols|col-span|items|justify|overflow|cursor'
    + '|duration|animate|whitespace|backdrop|placeholder|min-w|min-h|max-w|max-h|[wh]|[pm][xytblr]?)-'
    + '|(?:top|bottom|left|right|inset)-(?:\\d|\\[|full|auto|px)'
    // alone or with a value: border, border-b, flex, flex-1
    + '|(?:border|rounded|shadow|ring|outline|transition|flex|grid|inline|shrink|grow)(?:-|$)'
    // alone only
    + '|(?:hidden|block|absolute|relative|fixed|sticky|truncate|uppercase|italic|underline)$)');

// Class names in a file: class="..." values, and strings in its scripts that are lists of class names
const classesIn = (text, isHtml = false) => {
    const found = [];
    for (const m of text.matchAll(/class(?:Name)?\s*=\s*"([^"]*)"/g)) found.push(...m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/));
    const scripts = isHtml ? [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]) : [text];
    for (const script of scripts) {
        for (const m of script.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"/g)) {
            const words = (m[1] ?? m[2]).trim().split(/\s+/);
            if (words.every(w => /^[a-z0-9:\-\/\[\]#.%_]+$/.test(w))) found.push(...words.filter(w => UTILITY.test(w)));
        }
    }
    return found.filter(c => c && !c.includes('$') && !/^fa(-|$)/.test(c) && !c.startsWith('toastui') && !ownClasses.has(c));
};

// How Tailwind writes a class name as a CSS selector
const selector = (name) => '.' + name.replace(/[:\/\[\]#.%]/g, ch => `\\${ch}`);
const inCss = (name) => {
    const s = selector(name);
    let at = css.indexOf(s);
    while (at !== -1) {
        if (!/[\w-]/.test(css[at + s.length] || '')) return true;
        at = css.indexOf(s, at + 1);
    }
    return false;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('every Tailwind class the pages use is in shared/tailwind.css (else run: npm run css)', () => {
    const missing = new Set();
    for (const file of pages) {
        for (const name of classesIn(read(file), file.endsWith('.html'))) if (!inCss(name)) missing.add(`${name} (${file})`);
    }
    assert.deepStrictEqual([...missing], []);
});

test('the check finds classes, and would notice one that is missing', () => {
    assert.ok(inCss('bg-gray-900') && inCss('hover:bg-gray-600') && inCss('z-[10000]') && inCss('bg-orange-900/40'));
    assert.ok(!inCss('bg-gray-9') && !inCss('not-a-real-class'));
    assert.deepStrictEqual(classesIn('<div class="flex ${x ? \'a\' : \'\'} fa-solid made-up-class">'), ['flex', 'made-up-class']);
    assert.deepStrictEqual(classesIn("mark('border-teal-700 bg-teal-900/20'); get('left-input'); alert('Enter a link first.');"), ['border-teal-700', 'bg-teal-900/20']);
    assert.deepStrictEqual(classesIn('<a id="file-input" class="w-full"><script>x("hidden")</script>', true), ['w-full', 'hidden']);
});

test('the pages load the built styles, not the Tailwind CDN', () => {
    for (const file of pages.filter(f => f.endsWith('.html'))) {
        const html = read(file);
        assert.ok(!html.includes('cdn.tailwindcss.com'), `${file} still loads the Tailwind CDN`);
        if (/class="[^"]*\b(flex|grid|hidden)\b/.test(html)) assert.ok(html.includes('../shared/tailwind.css'), `${file} doesn't load shared/tailwind.css`);
    }
});

run(tests);
