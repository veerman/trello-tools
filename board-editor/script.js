class EditorAdapter {
    constructor(targetElementId, options = {}) {
        this.targetId = targetElementId;
        this.syncTarget = options.syncTarget || null;

        const Editor = toastui.Editor;
        const toolbarItems = [
            ['heading', 'bold', 'italic'],
            ['ul', 'ol', 'task'],
            ['table', 'link', 'image'],
            ['quote']
        ];

        this.instance = new Editor({
            el: document.querySelector(`#${targetElementId}`),
            height: options.height || '600px',
            initialEditType: 'markdown',
            previewStyle: 'tab',
            // Keeps the board details block at the top intact in the Doc view
            frontMatter: true,
            initialValue: '',
            theme: 'dark',
            toolbarItems: toolbarItems,
            events: {
                change: () => this._syncToHiddenInput()
            },
            hooks: {
                // This hook intercepts image uploads/drops and disables the file-to-base64 conversion
                addImageBlobHook: () => {
                    return false; 
                }
            }
        });
    }

    getMarkdown() { 
        const rawMarkdown = this.instance.getMarkdown();
        return rawMarkdown.replace(/^(\s*)\*\s/gm, '$1- ');
    }

    setMarkdown(markdownText) {
        this.instance.setMarkdown(markdownText);
        this._syncToHiddenInput();
        requestAnimationFrame(() => {
            this.instance.moveCursorToStart();
            this.instance.focus();
        });
    }

    setViewMode(mode, overrideMarkdown = null) {
        const isCurrentlyWysiwyg = this.instance.isWysiwygMode();
        
        if (mode === 'markdown') {
            const md = overrideMarkdown !== null ? overrideMarkdown : (isCurrentlyWysiwyg ? this.getMarkdown() : null);
            this.instance.changeMode('markdown');
            this.instance.changePreviewStyle('tab');
            if (md) this.setMarkdown(md);
        } else if (mode === 'split') {
            const md = overrideMarkdown !== null ? overrideMarkdown : (isCurrentlyWysiwyg ? this.getMarkdown() : null);
            this.instance.changeMode('markdown');
            this.instance.changePreviewStyle('vertical');
            if (md) this.setMarkdown(md);
        } else if (mode === 'wysiwyg') {
            if (overrideMarkdown !== null) this.setMarkdown(overrideMarkdown);
            this.instance.changeMode('wysiwyg');
        }
        
        requestAnimationFrame(() => {
            this.instance.moveCursorToStart();
            this.instance.focus();
        });
    }

    _syncToHiddenInput() {
        if (this.syncTarget) this.syncTarget.value = this.getMarkdown();
    }
}

const VALID_COLORS = ['green', 'yellow', 'orange', 'red', 'purple', 'blue', 'sky', 'lime', 'pink', 'black'];

function restoreTrelloHierarchy(inputText) {
    const sanitizedText = inputText.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
    const lines = sanitizedText.split('\n');

    const parsedLines = lines.map(line => {
        let normalizedLine = line;
        
        normalizedLine = normalizedLine.replace(/^(\s*)(?:[-*])\s/, (match, spaces) => {
            const reducedSpaces = spaces.length > 0 ? ' '.repeat(Math.floor(spaces.length / 2)) : '';
            return `${reducedSpaces}- `;
        });
        
        normalizedLine = normalizedLine.replace(/^(\s+)(\d+\.\s)/, (match, spaces, digits) => {
            const reducedSpaces = ' '.repeat(Math.floor(spaces.length / 2));
            return `${reducedSpaces}${digits}`;
        });
        
        const trimmed = normalizedLine.trim();
        const boldMatch = trimmed.match(/^\*\*(.+)\*\*$/);
        
        return {
            original: normalizedLine,
            trimmed: trimmed,
            isBold: !!boldMatch,
            boldText: boldMatch ? boldMatch[1].trim() : null,
            type: 'unknown'
        };
    });
    
    let foundH1 = false;
    
    for (let i = 0; i < parsedLines.length; i++) {
        const node = parsedLines[i];
        if (!node.isBold) continue;
        
        if (!foundH1) {
            node.type = 'h1';
            foundH1 = true;
            continue;
        }
        
        const colorMatch = node.boldText.match(/\[([a-z]+)\]$/i);
        if (colorMatch && VALID_COLORS.includes(colorMatch[1].toLowerCase())) {
            node.type = 'h3';
            continue;
        }
    }
    
    for (let i = 0; i < parsedLines.length; i++) {
        const node = parsedLines[i];
        if (node.isBold && node.type === 'unknown') {
            let nextNonEmptyNode = null;
            
            for (let j = i + 1; j < parsedLines.length; j++) {
                if (parsedLines[j].trimmed.length > 0) {
                    nextNonEmptyNode = parsedLines[j];
                    break;
                }
            }
            
            if (nextNonEmptyNode && nextNonEmptyNode.type === 'h3') {
                node.type = 'h2';
            } else {
                node.type = 'text';
            }
        }
    }
    
    const joinedText = parsedLines.map(node => {
        if (!node.isBold || node.type === 'text') {
            return node.original;
        }
        
        const cleanText = node.boldText.replace(/^[#*\s]+|[#*\s]+$/g, '');
        
        switch (node.type) {
            case 'h1': return `# ${cleanText}`;
            case 'h2': return `## ${cleanText}`;
            case 'h3': return `### ${cleanText}`;
            default: return node.original;
        }
    }).join('\n');
    
    return joinedText
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/^(#+ .*)$/gm, '\n$1\n')
        .replace(/^\n+/, '')
        .replace(/\n{3,}/g, '\n\n');
}

// Board text can come from shared boards or a ?url= link, so it is escaped (escapeHtml, in
// shared/trello.js) before it goes into innerHTML.
// Only web, mail and relative links survive, so a board can't smuggle in javascript: links.
// Browsers ignore control characters and spaces inside a scheme, so test without them.
const safeUrl = (url) => {
    const value = String(url ?? '').trim();
    const compact = value.replace(/[\u0000- \u007f]/g, '');
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(compact);
    return !hasScheme || /^(https?|mailto):/i.test(compact) ? value : '#';
};

const renderMarkdownPreview = (textArray) => {
    if (!textArray || textArray.length === 0) return '';
    
    let html = [];
    let inList = false;
    let listType = '';

    const closeList = () => {
        if (inList) {
            html.push(listType === 'ul' ? '</ul>' : '</ol>');
            inList = false;
        }
    };

    textArray.forEach(line => {
        let parsed = line.trimEnd();
        
        parsed = parsed.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
        parsed = escapeHtml(parsed);

        const placeholders = [];
        const stash = (htmlString) => {
            placeholders.push(htmlString);
            return `%%%MDSTASH${placeholders.length - 1}%%%`;
        };

        parsed = parsed.replace(/`([^`]+)`/g, (_, code) => stash(`<code class="bg-gray-800 text-pink-400 px-1 rounded">${code}</code>`));
        // Link titles (already escaped here, so quoted as &quot;) are not part of the address
        const linkTarget = (url) => safeUrl(url.replace(/\s+&quot;.*&quot;\s*$/, ''));
        parsed = parsed.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => stash(`<img src="${linkTarget(url)}" alt="${alt}" class="max-w-full rounded my-2 border border-gray-700">`));
        parsed = parsed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => stash(`<a href="${linkTarget(url)}" class="text-blue-400 hover:underline" target="_blank">${text}</a>`));

        parsed = parsed.replace(/\*\*(.*?)\*\*/g, '<strong class="text-gray-100">$1</strong>');
        parsed = parsed.replace(/__(.*?)__/g, '<strong class="text-gray-100">$1</strong>');
        parsed = parsed.replace(/\*(.*?)\*/g, '<em class="text-gray-400">$1</em>');
        parsed = parsed.replace(/_(.*?)_/g, '<em class="text-gray-400">$1</em>');

        placeholders.forEach((htmlString, i) => {
            parsed = parsed.replace(`%%%MDSTASH${i}%%%`, htmlString);
        });

        const ulMatch = parsed.match(/^(\s*)(?:[-*])\s+(.*)$/);
        const olMatch = parsed.match(/^(\s*)\d+\.\s+(.*)$/);
        const headerMatch = parsed.match(/^(#{1,6})\s+(.*)$/);

        if (ulMatch) {
            if (inList && listType !== 'ul') closeList();
            if (!inList) { html.push('<ul class="list-disc ml-5 space-y-1 mb-3">'); inList = true; listType = 'ul'; }
            html.push(`<li>${ulMatch[2]}</li>`);
        } else if (olMatch) {
            if (inList && listType !== 'ol') closeList();
            if (!inList) { html.push('<ol class="list-decimal ml-5 space-y-1 mb-3">'); inList = true; listType = 'ol'; }
            html.push(`<li>${olMatch[2]}</li>`);
        } else if (headerMatch) {
            closeList();
            const level = headerMatch[1].length;
            const content = headerMatch[2];
            const size = level === 1 ? 'text-lg' : level === 2 ? 'text-base' : 'text-sm';
            html.push(`<h${level} class="font-bold text-white mt-4 mb-2 ${size}">${content}</h${level}>`);
        } else if (parsed.trim() === '') {
            closeList();
            html.push('<div class="h-2"></div>');
        } else {
            closeList();
            html.push(`<p class="mb-2">${parsed}</p>`);
        }
    });
    
    closeList();
    return html.join('\n');
};

const buildModalContent = (card, colorMap) => {
    let contentHtml = '';
    
    if (card.color && colorMap[card.color]) {
        contentHtml += `<div class="h-4 w-16 rounded ${colorMap[card.color]} mb-6 shadow-sm"></div>`;
    }
    
    if (card.desc && card.desc.length > 0) {
        contentHtml += `<div class="mb-6">
            <h4 class="text-gray-400 uppercase text-xs font-bold mb-2 flex items-center gap-2"><i class="fa-solid fa-align-left"></i> description</h4>
            <div class="bg-gray-900 p-4 rounded border border-gray-700 text-sm text-gray-300 leading-relaxed">${renderMarkdownPreview(card.desc)}</div>
        </div>`;
    }
    
    if (card.checklists && card.checklists.length > 0) {
        card.checklists.forEach(cl => {
            contentHtml += `<div class="mb-6">
                <h4 class="text-gray-400 uppercase text-xs font-bold mb-2 flex items-center gap-2"><i class="fa-regular fa-square-check"></i> ${escapeHtml(cl.name)}</h4>
                <div class="bg-gray-900 p-3 rounded border border-gray-700">
                    <ul class="space-y-2">`;
            cl.items.forEach(item => {
                contentHtml += `<li class="flex items-start gap-3 text-sm text-gray-300">
                    <input type="checkbox" class="mt-1" disabled ${item.checked ? 'checked' : ''}>
                    <span class="leading-snug">${escapeHtml(item.name)}</span>
                </li>`;
            });
            contentHtml += `</ul></div></div>`;
        });
    }
    
    if (card.attachments && card.attachments.length > 0) {
        contentHtml += `<div class="mb-6">
            <h4 class="text-gray-400 uppercase text-xs font-bold mb-2 flex items-center gap-2"><i class="fa-solid fa-paperclip"></i> attachments</h4>
            <div class="bg-gray-900 p-3 rounded border border-gray-700">
                <ul class="space-y-2">`;
        card.attachments.forEach(att => {
            contentHtml += `<li><a href="${escapeHtml(safeUrl(att.url))}" target="_blank" class="text-blue-400 hover:text-blue-300 hover:underline flex items-center gap-2 text-sm truncate"><i class="fa-solid fa-link"></i> ${escapeHtml(att.name)}</a></li>`;
        });
        contentHtml += `</ul></div></div>`;
    }

    return contentHtml || `<div class="text-gray-500 italic text-sm">this card has no additional data.</div>`;
};

const buildCardTileHtml = (card, colorMap) => {
    let innerHtml = '';
    if (card.color && colorMap[card.color]) {
        innerHtml += `<div class="h-8 w-full ${colorMap[card.color]} border-b border-gray-700/50"></div>`;
    }

    innerHtml += `<div class="p-3 pt-2">`;
    innerHtml += `<div class="text-sm text-gray-200 mb-2 leading-snug group-hover:text-white transition-colors">${escapeHtml(card.name)}</div>`;

    const hasDesc = card.desc && card.desc.length > 0;
    const hasChecklist = card.checklists && card.checklists.length > 0;
    const hasAttachments = card.attachments && card.attachments.length > 0;

    if (hasDesc || hasChecklist || hasAttachments) {
        innerHtml += `<div class="flex gap-3 text-gray-400 text-xs mt-1">`;
        if (hasDesc) innerHtml += `<div title="description"><i class="fa-solid fa-align-left"></i></div>`;
        if (hasChecklist) {
            const totalItems = card.checklists.reduce((sum, cl) => sum + cl.items.length, 0);
            innerHtml += `<div title="checklists"><i class="fa-regular fa-square-check"></i> ${totalItems}</div>`;
        }
        if (hasAttachments) innerHtml += `<div title="attachments"><i class="fa-solid fa-paperclip"></i> ${card.attachments.length}</div>`;
        innerHtml += `</div>`;
    }

    innerHtml += `</div>`;
    return innerHtml;
};

// Normalizes a card description the same way trello_export.py does
const processDescription = (desc) => {
    let listCounter = 1;
    const cleanDesc = desc
        .replace(/[​-‍﻿]/g, '')
        .replace(/(?:\r?\n[ \t]*){2,}/g, '\n\n')
        .trim();

    return cleanDesc
        .replace(/^(#{1,6})\s+(.*)$/gm, (_, hashes, text) => `**${text.replace(/^\*\*|\*\*$/g, '').trim()}**`)
        .split('\n')
        .filter((line, index, arr) => {
            if (line.trim() !== '') return true;
            const prev = arr[index - 1] || '';
            const next = arr[index + 1] || '';
            return !(/^\s*\d+\.\s/.test(prev) && /^\s*\d+\.\s/.test(next));
        })
        .map(line => {
            const listMatch = line.match(/^(\s*)\d+\.\s(.*)$/);
            if (listMatch) {
                return `${listMatch[1]}${listCounter++}. ${listMatch[2]}`;
            }
            if (line.trim() !== '') listCounter = 1;
            return line;
        }).join('\n');
};

// The board's own details (id, link, workspace, dates) go in a front matter block at the top.
// It is not board content: Save to Trello skips it. Must match front_matter in board_markdown.py.
const frontMatter = (boardData) => {
    const id = boardData.id || '';
    const lines = [];
    if (id) lines.push(`trello_board: ${id}`);
    if (boardData.shortUrl) lines.push(`url: ${boardData.shortUrl}`);
    if (boardData.organization && boardData.organization.displayName) lines.push(`workspace: ${JSON.stringify(boardData.organization.displayName)}`);
    // A Trello id starts with its creation time in seconds, as 8 hex digits
    if (/^[0-9a-f]{24}$/.test(id)) lines.push(`created: ${new Date(parseInt(id.slice(0, 8), 16) * 1000).toISOString().slice(0, 10)}`);
    if (boardData.dateLastActivity) lines.push(`last_activity: ${boardData.dateLastActivity.slice(0, 10)}`);
    return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
};

// Finds a front matter block (--- lines) at the very top: its fields, and the line where the board starts
const splitFrontMatter = (lines) => {
    if ((lines[0] || '').trim() !== '---') return { meta: {}, start: 0 };
    const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end === -1) return { meta: {}, start: 0 };
    const meta = {};
    lines.slice(1, end).forEach(line => {
        const field = line.match(/^([A-Za-z_]+):\s*(.*)$/);
        if (!field) return;
        let value = field[2].trim();
        if (value.startsWith('"')) {
            try { value = JSON.parse(value); } catch (e) { /* keep it as written */ }
        }
        meta[field[1]] = value;
    });
    return { meta, start: end + 1 };
};

// An attachment link may end with a title, which the backup uses for the file's fingerprint:
// [Plan.docx](https://... "sha256:3f2a9c1b7d4e5a60"). The link itself is everything before it.
const withoutLinkTitle = (url) => url.replace(/\s+"[^"]*"\s*$/, '').trim();

// Trello board JSON in, Markdown out (see trello-markdown-guide.md)
const boardToMarkdown = (boardData) => {
    let md = `${frontMatter(boardData)}# ${boardData.name}\n\n`;
    // Archived lists and cards are left out so Save to Trello can't bring them back
    const sortedLists = boardData.lists.filter(list => !list.closed).sort((a, b) => a.pos - b.pos);
    const cardsByList = {};

    boardData.cards.filter(card => !card.closed).forEach(card => {
        if (!cardsByList[card.idList]) cardsByList[card.idList] = [];
        cardsByList[card.idList].push(card);
    });

    sortedLists.forEach(list => {
        md += `## ${list.name}\n\n`;
        const listCards = (cardsByList[list.id] || []).sort((a, b) => a.pos - b.pos);
        if (listCards.length === 0) return;

        listCards.forEach(card => {
            const colorTag = card.cover && card.cover.color ? ` [${card.cover.color}]` : ' []';
            md += `### ${card.name}${colorTag}\n\n`;

            if (card.desc) {
                md += `${processDescription(card.desc)}\n\n`;
            }

            if (boardData.checklists && boardData.checklists.length > 0) {
                const cardChecklists = boardData.checklists.filter(cl => cl.idCard === card.id).sort((a,b) => a.pos - b.pos);
                cardChecklists.forEach(cl => {
                    md += `#### ${cl.name || 'Checklist'}\n`;
                    const items = (cl.checkItems || []).sort((a,b) => a.pos - b.pos);
                    items.forEach(item => { md += `- ${item.state === 'complete' ? '[x] ' : ''}${item.name}\n`; });
                    md += `\n`;
                });
            }

            if (card.attachments && card.attachments.length > 0) {
                md += `##### Attachments\n`;
                card.attachments.forEach(att => {
                    const rawName = att.name || att.url;
                    const safeName = rawName.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
                    const safeUrl = att.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
                    md += `- [${safeName}](${safeUrl})\n`;
                });
                md += `\n`;
            }
        });
    });
    return md;
};

// Markdown in, board data out: { name, meta, lists: [{ name, cards: [{ name, color, desc, checklists, attachments }] }] }
// meta holds the front matter fields, if any.
const parseMarkdownToData = (markdown) => {
    const lines = markdown.split('\n');
    const { meta, start } = splitFrontMatter(lines);
    const data = { name: 'New Board', meta, lists: [] };
    let currentList = null;
    let currentCard = null;
    let currentSection = null;

    for (let i = start; i < lines.length; i++) {
        let line = lines[i].trimEnd();
        const trimmed = line.trim();

        if (!trimmed && currentSection !== 'desc') continue;

        if (trimmed && line.startsWith('# ')) {
            data.name = line.substring(2).trim();
            continue;
        }
        if (trimmed && line.startsWith('## ')) {
            currentList = { name: line.substring(3).trim(), cards: [] };
            data.lists.push(currentList);
            currentCard = null;
            currentSection = null;
            continue;
        }
        if (trimmed && line.startsWith('### ')) {
            if (!currentList) { currentList = { name: '(Unlisted)', cards: [] }; data.lists.push(currentList); }
            const rawName = line.substring(4).trim();
            const colorMatch = rawName.match(/^(.*)\s+\[([a-zA-Z]*)\]$/);
            let cardName = rawName;
            let cardColor = null;

            if (colorMatch) {
                const potentialColor = colorMatch[2].toLowerCase();
                if (VALID_COLORS.includes(potentialColor)) {
                    cardName = colorMatch[1];
                    cardColor = potentialColor;
                } else if (potentialColor === '') {
                    cardName = colorMatch[1];
                }
            }

            currentCard = { name: cardName, color: cardColor, desc: [], checklists: [], attachments: [] };
            currentList.cards.push(currentCard);
            currentSection = 'desc';
            continue;
        }
        if (trimmed && line.startsWith('#### ')) {
            if (currentCard) {
                currentCard.checklists.push({ name: line.substring(5).trim(), items: [] });
                currentSection = 'checklist';
            }
            continue;
        }
        if (trimmed && line.match(/^#####\s*Attachments:?$/i)) {
            currentSection = 'attachments';
            continue;
        }
        if (trimmed && line.match(/^######\s*Comments:?$/i)) {
            // Written by the backup for reference; comments are never recreated
            currentSection = 'comments';
            continue;
        }
        if (currentCard) {
            if (currentSection === 'checklist') {
                if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
                    const lastCl = currentCard.checklists[currentCard.checklists.length - 1];
                    if (lastCl) {
                        // "- [x] Item" is ticked; "- [ ] Item" and "- Item" are not
                        const itemText = trimmed.substring(2).trim();
                        const tickMatch = itemText.match(/^\[([ xX])\]\s+(.*)$/);
                        lastCl.items.push(tickMatch
                            ? { name: tickMatch[2].trim(), checked: tickMatch[1].toLowerCase() === 'x' }
                            : { name: itemText, checked: false });
                    }
                }
            } else if (currentSection === 'attachments') {
                if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
                    const content = trimmed.substring(2).trim();
                    const linkMatch = content.match(/\[(.*?)\]\((.*?)\)/);
                    // The exporter escapes brackets in names as \[ and \]
                    if (linkMatch) currentCard.attachments.push({ name: linkMatch[1].replace(/\\([[\]])/g, '$1'), url: withoutLinkTitle(linkMatch[2]) });
                    else currentCard.attachments.push({ name: content, url: content });
                }
            } else if (currentSection === 'desc') {
                currentCard.desc.push(line);
            }
        }
    }
    return data;
};

// 1 for identical text, 0 for nothing in common (edit distance over the longer length)
const similarity = (first, second) => {
    const a = first.toLowerCase();
    const b = second.toLowerCase();
    const longer = Math.max(a.length, b.length);
    if (!longer) return 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const curr = [i];
        for (let j = 1; j <= b.length; j++) {
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = curr;
    }
    return 1 - prev[b.length] / longer;
};

// What changed between two parsed boards, as plain sentences
const compareBoards = (before, after) => {
    const changes = [];
    const cardsOf = (data) => data.lists.flatMap(list => list.cards.map(card => ({ ...card, list: list.name })));
    const beforeLists = before.lists.map(l => l.name);
    const afterLists = after.lists.map(l => l.name);
    beforeLists.filter(name => !afterLists.includes(name)).forEach(name => changes.push(`Removed list: "${name}"`));
    afterLists.filter(name => !beforeLists.includes(name)).forEach(name => changes.push(`New list: "${name}"`));

    const beforeCards = cardsOf(before);
    const afterCards = cardsOf(after);
    const afterNames = afterCards.map(c => c.name);
    const beforeNames = beforeCards.map(c => c.name);
    let added = afterCards.filter(c => !beforeNames.includes(c.name));

    // A missing card with a close match in the same list was most likely renamed.
    // A trailing [tag] is ignored for the match; a bad colour tag gets its own warning.
    const withoutTag = (name) => name.replace(/\s*\[[^\]]*\]$/, '');
    beforeCards.filter(c => !afterNames.includes(c.name)).forEach(removed => {
        const best = added
            .filter(c => c.list === removed.list)
            .map(c => ({ card: c, score: similarity(withoutTag(removed.name), withoutTag(c.name)) }))
            .filter(match => match.score >= 0.5)
            .sort((x, y) => y.score - x.score)[0];
        if (best) {
            changes.push(`Renamed? "${removed.name}" is now "${best.card.name}" (${removed.list})`);
            added = added.filter(c => c !== best.card);
        } else {
            changes.push(`Removed card: "${removed.name}" (${removed.list})`);
        }
    });
    added.forEach(c => changes.push(`New card: "${c.name}" (${c.list})`));

    const itemCount = (card) => card.checklists.reduce((sum, cl) => sum + cl.items.length, 0);
    let descriptionsChanged = 0;
    beforeCards.forEach(b => {
        const a = afterCards.find(c => c.name === b.name);
        if (!a) return;
        if (a.list !== b.list) changes.push(`Moved: "${b.name}" from ${b.list} to ${a.list}`);
        const afterUrls = a.attachments.map(att => att.url);
        b.attachments.filter(att => !afterUrls.includes(att.url))
            .forEach(att => changes.push(`Removed attachment: "${att.name}" from "${b.name}"`));
        if (itemCount(a) < itemCount(b)) changes.push(`Fewer checklist items: "${b.name}" went from ${itemCount(b)} to ${itemCount(a)}`);
        if (a.desc.join('\n').trim() !== b.desc.join('\n').trim()) descriptionsChanged++;
    });
    if (descriptionsChanged) changes.push(`${descriptionsChanged} card description${descriptionsChanged === 1 ? '' : 's'} changed`);
    return changes;
};

// Checks Markdown the way Save to Trello reads it. Problems would fail or build the wrong board,
// warnings are content that would be ignored, and changes compare with the original file.
const checkBoardMarkdown = (markdown, originalMarkdown = null) => {
    const problems = [];
    const warnings = [];
    let inList = false;
    let inCard = false;
    let section = null;
    let titleCount = 0;
    const allLines = markdown.split('\n');
    const { start } = splitFrontMatter(allLines);

    allLines.forEach((rawLine, index) => {
        const line = rawLine.trimEnd();
        const trimmed = line.trim();
        const at = `Line ${index + 1}:`;
        if (!trimmed || index < start) return;

        if (line.startsWith('# ')) {
            titleCount++;
            if (titleCount > 1) warnings.push(`${at} a second # title "${line.substring(2).trim()}" would replace the board name. Inside a description, use **bold** instead of # headings.`);
            return;
        }
        if (line.startsWith('## ')) {
            inList = true;
            inCard = false;
            section = null;
            return;
        }
        if (line.startsWith('### ')) {
            const name = line.substring(4).trim();
            if (!inList) warnings.push(`${at} card "${name}" comes before any ## list, so it would go in an extra list called (Unlisted).`);
            const tag = name.match(/\s\[([a-zA-Z]+)\]$/);
            if (tag && !VALID_COLORS.includes(tag[1].toLowerCase())) {
                warnings.push(`${at} [${tag[1]}] is not a cover colour, so it stays in the card title. Colours: ${VALID_COLORS.join(', ')}. If it belongs in the title, end the line with [].`);
            }
            inCard = true;
            section = 'desc';
            return;
        }
        if (line.startsWith('#### ')) {
            if (inCard) section = 'checklist';
            else warnings.push(`${at} checklist "${line.substring(5).trim()}" is not inside a card, so it is ignored.`);
            return;
        }
        if (/^#####\s*Attachments:?$/i.test(line)) {
            if (inCard) section = 'attachments';
            else warnings.push(`${at} this Attachments section is not inside a card, so it is ignored.`);
            return;
        }
        if (/^######\s*Comments:?$/i.test(line)) {
            if (inCard) section = 'comments';
            return;
        }
        if (/^#{5,6}\s/.test(line)) {
            warnings.push(`${at} "${trimmed}" is not a heading the editor knows, so it becomes description text. Use "##### Attachments" for links.`);
            return;
        }

        if (!inCard) {
            warnings.push(inList ? `${at} text between a list and its first card is ignored.` : `${at} text before the first list is ignored.`);
            return;
        }
        const isItem = trimmed.startsWith('- ') || trimmed.startsWith('* ');
        if (section === 'checklist' && !isItem) {
            warnings.push(`${at} only "- " items are kept under a checklist, so this line is ignored.`);
        } else if (section === 'attachments') {
            if (!isItem) {
                warnings.push(`${at} only "- [name](link)" items are kept under Attachments, so this line is ignored.`);
                return;
            }
            const item = trimmed.substring(2).trim();
            const link = item.match(/\[(.*?)\]\((.*?)\)/);
            if (!link) problems.push(`${at} attachment "${item}" is not a link. Use - [name](https://...).`);
            else if (!/^https?:\/\//i.test(withoutLinkTitle(link[2]))) problems.push(`${at} attachment link "${withoutLinkTitle(link[2])}" must start with http:// or https://.`);
        }
    });

    const data = parseMarkdownToData(markdown);
    if (data.lists.length === 0) problems.push('Nothing to create: add at least one ## list.');
    data.lists.forEach(list => list.cards.forEach(card => {
        const length = card.desc.join('\n').trim().length;
        if (length > 16384) problems.push(`Card "${card.name}": the description is ${length.toLocaleString('en-US')} characters, and Trello's limit is 16,384.`);
    }));

    const changes = originalMarkdown ? compareBoards(parseMarkdownToData(originalMarkdown), data) : [];
    return { problems, warnings, changes };
};

const summarizeCheck = (check) => {
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const parts = [];
    if (check.problems.length) parts.push(count(check.problems.length, 'problem'));
    if (check.warnings.length) parts.push(count(check.warnings.length, 'warning'));
    if (check.changes.length) parts.push(count(check.changes.length, 'change'));
    return parts.length ? parts.join(', ') : 'Ready to save';
};

// Plain text version of the check, for pasting back into an AI tool
const formatCheckReport = (check, originalLabel) => {
    const block = (title, items) => items.length ? [title, ...items.map(item => `- ${item}`), ''] : [];
    const lines = [
        ...block('Problems (fix these before saving):', check.problems),
        ...block('Warnings (this content would be ignored):', check.warnings),
        ...block(`Changes compared with ${originalLabel || 'the original'}:`, check.changes)
    ];
    return lines.length ? lines.join('\n').trim() : 'No problems found.';
};

document.addEventListener('DOMContentLoaded', () => {

    const connectTrelloBtn = document.getElementById('connect-trello-btn');
    const trelloConnectContainer = document.getElementById('trello-connect-container');
    const logoutBtn = document.getElementById('logout-btn');
    const trelloSelectionContainer = document.getElementById('trello-selection-container');
    const workspaceSelector = document.getElementById('workspace-selector');
    const boardSelector = document.getElementById('board-selector');
    const refreshBoardsBtn = document.getElementById('refresh-boards-btn');
    const saveToTrelloBtn = document.getElementById('save-to-trello-btn');
    const saveToFileBtn = document.getElementById('save-to-file-btn');
    const fileInput = document.getElementById('file-input');
    const statusMessage = document.getElementById('status-message');
    const hiddenTextArea = document.getElementById('hidden-board-content');
    const viewToggleBtns = document.querySelectorAll('.view-toggle-btn');
    const boardLinkContainer = document.getElementById('board-link-container');
    const viewBoardLink = document.getElementById('view-board-link');
    const urlInput = document.getElementById('url-input');
    const loadUrlBtn = document.getElementById('load-url-btn');
    
    const popupObserver = new MutationObserver(() => {
        const popup = document.querySelector('.toastui-editor-popup-add-image');
        if (popup && popup.style.display !== 'none') {
            const tabs = popup.querySelectorAll('.tab-item');
            if (tabs.length > 1 && !tabs[1].classList.contains('active')) {
                tabs[1].click();
            }
        }
    });
    
    popupObserver.observe(document.body, { 
        childList: true, 
        subtree: true, 
        attributes: true, 
        attributeFilter: ['style', 'class'] 
    });

    // Login, API key and API calls are shared with the other pages (shared/trello.js)
    let trelloToken = trello.init();
    let workspaces = {};
    let statusTimeout;
    let editorAdapter = null;
    let activeBoardFetchId = 0;
    let pasteDebounce;
    let lastLoadedFilename = null;
    // The board as first loaded, so the check can show what an edit or an AI pass changed
    let originalMarkdown = null;
    let originalLabel = '';
    let checkDebounce;
    
    const generateModifyPromptBtn = document.getElementById('generate-modify-prompt-btn');
    const generateQueryPromptBtn = document.getElementById('generate-query-prompt-btn');
    const promptModal = document.getElementById('prompt-modal');
    const closePromptModalBtn = document.getElementById('close-prompt-modal-btn');
    const promptTextarea = document.getElementById('prompt-textarea');
    const copyPromptBtn = document.getElementById('copy-prompt-btn');
    const promptModalTitle = document.getElementById('prompt-modal-title');

    const executePromptFetch = async (btnElement, fileName, titleText, iconClass) => {
        const originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = '<i class="fa-solid fa-spinner fa-spin text-blue-400 w-4 text-center"></i> Compiling...';
        
        try {
            const bust = `?v=${Date.now()}`;
            const [schemaResponse, promptResponse] = await Promise.all([
                fetch(`trello-markdown-guide.md${bust}`),
                fetch(`${fileName}${bust}`)
            ]);

            if (!schemaResponse.ok || !promptResponse.ok) {
                throw new Error(`Failed to fetch ${fileName} or schema.`);
            }

            const schemaText = await schemaResponse.text();
            let promptTemplate = await promptResponse.text();

            // Function replacers, so a "$" in the guide is inserted as is rather than read as a pattern
            let finalPrompt = promptTemplate.replace('[Paste schema here]', () => schemaText);
            finalPrompt = finalPrompt.replace('[Insert schema here]', () => schemaText);

            if (promptModalTitle) {
                promptModalTitle.innerHTML = `<i class="${iconClass} text-blue-500"></i> ${titleText}`;
            }

            promptTextarea.value = finalPrompt;
            promptModal.classList.remove('hidden');
        } catch (error) {
            showStatus("Error generating prompt: " + error.message, true);
            console.error(error);
        } finally {
            btnElement.innerHTML = originalHtml;
        }
    };

    if (generateModifyPromptBtn) {
        generateModifyPromptBtn.addEventListener('click', (e) => {
            e.preventDefault();
            executePromptFetch(generateModifyPromptBtn, 'prompt_modify.txt', 'Modify Board Prompt', 'fa-solid fa-robot');
        });
    }

    if (generateQueryPromptBtn) {
        generateQueryPromptBtn.addEventListener('click', (e) => {
            e.preventDefault();
            executePromptFetch(generateQueryPromptBtn, 'prompt_query.txt', 'Query Board Prompt', 'fa-solid fa-comment-dots');
        });
    }

    if (closePromptModalBtn) {
        closePromptModalBtn.addEventListener('click', () => promptModal.classList.add('hidden'));
    }

    if (copyPromptBtn) {
        copyPromptBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(promptTextarea.value);
                const originalHtml = copyPromptBtn.innerHTML;
                copyPromptBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
                setTimeout(() => copyPromptBtn.innerHTML = originalHtml, 2000);
            } catch (err) {
                promptTextarea.select();
                document.execCommand('copy');
                const originalHtml = copyPromptBtn.innerHTML;
                copyPromptBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
                setTimeout(() => copyPromptBtn.innerHTML = originalHtml, 2000);
            }
        });
    }

    function updateViewToggles(activeBtn) {
        viewToggleBtns.forEach(b => {
            const isActive = b === activeBtn;
            b.classList.toggle('bg-blue-600', isActive);
            b.classList.toggle('text-white', isActive);
            b.classList.toggle('text-gray-400', !isActive);
            b.classList.toggle('hover:bg-gray-600', !isActive);
            b.classList.toggle('hover:text-white', !isActive);
        });
    }

    editorAdapter = new EditorAdapter('editor-container', {
        height: '600px',
        syncTarget: hiddenTextArea
    });

    const editorContainer = document.getElementById('editor-container');
    let isResolvingPaste = false;
    
    document.addEventListener('paste', (e) => {
        if (editorAdapter && editorAdapter.instance.isWysiwygMode()) {
            isResolvingPaste = true;
        }
    }, true);
    
    editorAdapter.instance.on('change', () => {
        saveToFileBtn.disabled = editorAdapter.getMarkdown().trim().length === 0;
        clearTimeout(checkDebounce);
        checkDebounce = setTimeout(() => runCheck(), 400);

        // Real-time board rendering for split-board mode
        const livePreviewBoard = document.getElementById('board-preview-container');
        const liveEditor = document.getElementById('editor-container');
        if (livePreviewBoard && !livePreviewBoard.classList.contains('hidden') && !liveEditor.classList.contains('hidden')) {
            clearTimeout(window.boardRenderDebounce);
            window.boardRenderDebounce = setTimeout(() => {
                if (typeof renderBoardPreview === 'function') renderBoardPreview();
            }, 300);
        }

        if (!isResolvingPaste) return;
        
        clearTimeout(pasteDebounce);
        pasteDebounce = setTimeout(() => {
            isResolvingPaste = false;
            
            const currentMarkdown = editorAdapter.getMarkdown();
            const hasStandaloneBold = /(?:^|\n)\s*\*\*[^*]+\*\*\s*(?:\n|$)/.test(currentMarkdown);
            
            if (!hasStandaloneBold) return;
            
            const restoredMarkdown = restoreTrelloHierarchy(currentMarkdown);
            
            if (restoredMarkdown !== currentMarkdown) {
                console.log('running restoration matrix on pasted doc content');
                
                const markdownBtn = Array.from(viewToggleBtns).find(btn => btn.dataset.mode === 'markdown');
                if (markdownBtn) updateViewToggles(markdownBtn);
                
                // Reset layout classes forcibly on paste restoration
                livePreviewBoard.classList.add('hidden');
                livePreviewBoard.classList.remove('w-1/2', 'w-full');
                liveEditor.classList.remove('hidden', 'w-1/2');
                liveEditor.classList.add('w-full');
                
                editorAdapter.setViewMode('markdown', restoredMarkdown);
            }
        }, 150);
    });

    const renderBoardPreview = () => {
        const previewContainer = document.getElementById('board-preview-container');
        previewContainer.innerHTML = '';
        
        const data = parseMarkdownToData(editorAdapter.getMarkdown());
        const colorMap = {
            'green': 'bg-green-500', 'yellow': 'bg-yellow-400', 'orange': 'bg-orange-500',
            'red': 'bg-red-500', 'purple': 'bg-purple-500', 'blue': 'bg-blue-500',
            'sky': 'bg-sky-400', 'lime': 'bg-lime-400', 'pink': 'bg-pink-400', 'black': 'bg-gray-900'
        };

        if (!data.lists || data.lists.length === 0) {
            previewContainer.innerHTML = '<div class="text-gray-500 text-sm italic w-full text-center mt-10">no board data available to render.</div>';
            return;
        }

        data.lists.forEach(list => {
            const listEl = document.createElement('div');
            listEl.className = 'flex-shrink-0 w-72 bg-gray-900 rounded-xl p-3 flex flex-col gap-2 max-h-[560px] overflow-y-auto border border-gray-700 shadow-md';
            
            const listHeader = document.createElement('h3');
            listHeader.className = 'font-bold text-gray-200 px-1 text-sm pb-1 sticky top-0 bg-gray-900 z-10 pt-1';
            listHeader.textContent = list.name;
            listEl.appendChild(listHeader);
            
            list.cards.forEach(card => {
                const cardEl = document.createElement('div');
                cardEl.className = 'bg-gray-800 rounded-lg shadow-sm overflow-hidden border border-gray-700 flex flex-col flex-shrink-0 cursor-pointer hover:border-gray-500 transition-colors group';
                cardEl.innerHTML = buildCardTileHtml(card, colorMap);
                
                cardEl.addEventListener('click', () => {
                    document.getElementById('modal-title').textContent = card.name;
                    document.getElementById('modal-content').innerHTML = buildModalContent(card, colorMap);
                    document.getElementById('card-modal').classList.remove('hidden');
                });
                
                listEl.appendChild(cardEl);
            });
            
            previewContainer.appendChild(listEl);
        });
    };

    const editorContainerDom = document.getElementById('editor-container');
    const boardPreviewContainer = document.getElementById('board-preview-container');

    viewToggleBtns.forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const mode = btn.dataset.mode;
            
            if (mode === 'preview') {
                editorContainerDom.classList.add('hidden');
                editorContainerDom.classList.remove('w-1/2');
                
                boardPreviewContainer.classList.remove('hidden', 'w-1/2');
                boardPreviewContainer.classList.add('w-full');
                
                renderBoardPreview();
            } else if (mode === 'split-board') {
                editorContainerDom.classList.remove('hidden', 'w-full');
                editorContainerDom.classList.add('w-1/2');
                
                boardPreviewContainer.classList.remove('hidden', 'w-full');
                boardPreviewContainer.classList.add('w-1/2');
                
                editorAdapter.setViewMode('markdown');
                renderBoardPreview();
                
                // Force Toast UI Canvas to recalculate dimensions
                setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
            } else {
                boardPreviewContainer.classList.add('hidden');
                boardPreviewContainer.classList.remove('w-1/2', 'w-full');
                
                editorContainerDom.classList.remove('hidden', 'w-1/2');
                editorContainerDom.classList.add('w-full');
                editorAdapter.setViewMode(mode);
            }
            
            updateViewToggles(btn);
        });
    });

    const cardModal = document.getElementById('card-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');
    
    if (closeModalBtn) {
        closeModalBtn.addEventListener('click', () => cardModal.classList.add('hidden'));
    }
    
    if (cardModal) {
        cardModal.addEventListener('click', (e) => {
            if (e.target === cardModal) cardModal.classList.add('hidden');
        });
    }

    const showStatus = (message, isError = false, duration = 5000) => {
        if (statusTimeout) clearTimeout(statusTimeout);
        statusMessage.textContent = message;
        statusMessage.className = `text-center text-xs p-2 rounded font-medium ${isError ? 'bg-red-900/50 text-red-200 border border-red-800' : 'bg-green-900/50 text-green-200 border border-green-800'}`;
        statusMessage.classList.remove('hidden');
        statusTimeout = setTimeout(() => statusMessage.classList.add('hidden'), duration);
    };

    const toggleSpinner = (btn, isLoading, originalText) => {
        if (isLoading) {
            btn.disabled = true;
            btn.innerHTML = `<div class="spinner"></div>`;
        } else {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    };

    trello.onPause = (seconds) => showStatus(`rate limit safety: pausing for ${seconds} seconds...`, false, seconds * 1000);
    const trelloFetch = (endpoint, options) => trello.fetch(endpoint, options);

    const loadMemberInfo = async () => {
        try {
            const member = await trelloFetch('members/me');
            const identifier = member.email || member.fullName || member.username;
            logoutBtn.innerHTML = `<i class="fa-solid fa-power-off"></i> disconnect ${escapeHtml(identifier)}`;
            logoutBtn.classList.remove('hidden');
        } catch (e) {
            console.error("failed to load user info", e);
            logoutBtn.innerHTML = `<i class="fa-solid fa-power-off"></i> disconnect`;
            logoutBtn.classList.remove('hidden');
        }
    };

    const fetchBoardToMarkdown = async (boardId) => {
        try {
            const boardData = await trelloFetch(`boards/${boardId}?fields=name,shortUrl,dateLastActivity&organization=true&organization_fields=displayName&lists=open&cards=open&checklists=all&card_attachments=true`);
            return boardToMarkdown(boardData);
        } catch (e) {
            throw new Error("failed to generate markdown: " + e.message);
        }
    };

    const loadBoards = async () => {
        if (!trelloToken) return;
        try {
            refreshBoardsBtn.classList.add('animate-spin');
            const members = await trelloFetch('members/me/boards?organization=true&organization_fields=displayName,url&filter=open');
            workspaces = {};
            members.forEach(board => {
                const orgId = board.idOrganization || 'personal';
                if (!workspaces[orgId]) workspaces[orgId] = { id: orgId, displayName: board.organization ? board.organization.displayName : 'Personal Boards', boards: [] };
                workspaces[orgId].boards.push({ id: board.id, name: board.name, url: board.url });
            });
            populateWorkspaces();
            refreshBoardsBtn.classList.remove('animate-spin');
        } catch (e) {
            showStatus("error loading boards: " + e.message, true);
            refreshBoardsBtn.classList.remove('animate-spin');
        }
    };

    const populateWorkspaces = () => {
        const selectedWs = workspaceSelector.value;
        workspaceSelector.innerHTML = '<option value="">-- Load Workspace --</option>';
        Object.values(workspaces).sort((a,b) => a.displayName.localeCompare(b.displayName)).forEach(ws => {
            const opt = document.createElement('option');
            opt.value = ws.id;
            opt.textContent = ws.displayName;
            workspaceSelector.appendChild(opt);
        });
        if (selectedWs && workspaces[selectedWs]) workspaceSelector.value = selectedWs;
    };

    const populateBoards = (wsId) => {
        boardSelector.innerHTML = '<option value="">-- Load Board --</option>';
        boardSelector.disabled = !wsId;
        if (wsId && workspaces[wsId]) {
            workspaces[wsId].boards.sort((a,b) => a.name.localeCompare(b.name)).forEach(b => {
                const opt = document.createElement('option');
                opt.value = b.id;
                opt.textContent = b.name;
                opt.dataset.url = b.url;
                boardSelector.appendChild(opt);
            });
            boardSelector.disabled = false;
        }
    };

    connectTrelloBtn.addEventListener('click', () => trello.connect());
    logoutBtn.addEventListener('click', () => trello.disconnect());

    workspaceSelector.addEventListener('change', (e) => {
        const wsId = e.target.value;
        populateBoards(wsId);
        if (wsId && trelloToken) {
            saveToTrelloBtn.disabled = false;
        } else {
            saveToTrelloBtn.disabled = true;
        }
    });

    refreshBoardsBtn.addEventListener('click', loadBoards);

    boardSelector.addEventListener('change', async (e) => {
        const boardId = e.target.value;
        if (!boardId) {
            boardLinkContainer.classList.add('hidden');
            return;
        }

        lastLoadedFilename = null;
        const option = e.target.options[e.target.selectedIndex];
        const boardUrl = option.dataset.url;
        if (boardUrl) {
            viewBoardLink.href = boardUrl;
            boardLinkContainer.classList.remove('hidden');
        }

        const currentFetchId = ++activeBoardFetchId;
        editorAdapter.setMarkdown("loading board data...");
        
        try {
            const md = await fetchBoardToMarkdown(boardId);
            if (currentFetchId !== activeBoardFetchId) return;

            editorAdapter.setMarkdown(md);
            setOriginal(md, `"${option.textContent}" from Trello`);
        } catch (err) {
            if (currentFetchId !== activeBoardFetchId) return;
            editorAdapter.setMarkdown("error: " + err.message);
        }
    });

    // Used by the Load from URL button and by ?url= links, which wait for it before applying ?view=
    const loadFromUrl = async () => {
        const url = urlInput.value.trim();
        if (!url) {
            showStatus("please enter a url first.", true);
            return;
        }

        toggleSpinner(loadUrlBtn, true, '<i class="fa-solid fa-cloud-arrow-down"></i>');

        try {
            // Intercept Trello URLs and route through the authenticated API
            const trelloBoardMatch = url.match(/trello\.com\/b\/([a-zA-Z0-9]+)/);
            
            if (trelloBoardMatch && trelloToken) {
                const shortId = trelloBoardMatch[1];
                editorAdapter.setMarkdown("loading trello board...");
                
                const md = await fetchBoardToMarkdown(shortId);
                editorAdapter.setMarkdown(md);
                setOriginal(md, `"${boardTitle(md)}" from Trello`);
                saveToFileBtn.disabled = false;
                if (trelloToken && workspaceSelector.value) saveToTrelloBtn.disabled = false;
                showStatus("successfully imported trello board from url.");
            } else {
                // Fallback standard fetch for raw markdown files
                const response = await fetch(url);
                if (!response.ok) throw new Error(`http error: ${response.status}`);
                const text = await response.text();

                editorAdapter.setMarkdown(text);
                // A file loaded after a board is usually the edited version, so keep the board as the original
                if (originalMarkdown === null) setOriginal(text, url);
                saveToFileBtn.disabled = false;
                if (trelloToken && workspaceSelector.value) saveToTrelloBtn.disabled = false;
                showStatus("successfully loaded from url.");
            }
        } catch (e) {
            showStatus("failed to load url (cors error?): " + e.message, true);
            if (editorAdapter.getMarkdown().trim() === 'loading trello board...') editorAdapter.setMarkdown('');
        } finally {
            toggleSpinner(loadUrlBtn, false, '<i class="fa-solid fa-cloud-arrow-down"></i>');
        }
    };
    loadUrlBtn.addEventListener('click', loadFromUrl);

    saveToFileBtn.addEventListener('click', () => {
        const content = editorAdapter.getMarkdown();
        if (content.trim().length === 0) return;

        let baseFilename = '';

        if (lastLoadedFilename) {
            baseFilename = lastLoadedFilename;
        } else {
            const lines = content.split('\n');
            const boardName = lines.find(l => l.startsWith('# '))?.replace('# ', '').trim() || 'Board';

            let wsName = '';
            if (workspaceSelector.value && workspaceSelector.selectedIndex > 0) {
                wsName = workspaceSelector.options[workspaceSelector.selectedIndex].text;
            }

            baseFilename = wsName ? `${wsName} - ${boardName}` : boardName;
            baseFilename = baseFilename.replace(/[<>:"/\\|?*]/g, '').trim();
        }

        const now = new Date();
        const pad = (n) => n.toString().padStart(2, '0');
        const datetimeStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

        const defaultFilename = `${baseFilename} [${datetimeStr}].md`;

        const confirmedFilename = prompt("Confirm filename to save:", defaultFilename);
        if (!confirmedFilename) return;

        const blob = new Blob([content], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = confirmedFilename;
        a.click();
        URL.revokeObjectURL(url);
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        lastLoadedFilename = file.name.replace(/\.md$/i, '').replace(/\s*\[\d{4}-\d{2}-\d{2}\s\d{2}-\d{2}-\d{2}\]$/, '');

        const reader = new FileReader();
        reader.onload = (evt) => {
            editorAdapter.setMarkdown(evt.target.result);
            if (originalMarkdown === null) setOriginal(evt.target.result, file.name);
            if (trelloToken && workspaceSelector.value) saveToTrelloBtn.disabled = false;
            fileInput.value = '';
        };
        reader.readAsText(file);
    });

    const saveToTrello = async () => {
        if (saveToTrelloBtn.disabled) return;
        
        const wsId = workspaceSelector.value;
        if (!wsId) { showStatus("please select a workspace above.", true); return; }
        const wsName = workspaceSelector.options[workspaceSelector.selectedIndex].text;

        const data = parseMarkdownToData(editorAdapter.getMarkdown());
        if (!data.lists.length) { showStatus("nothing to create: add at least one ## list.", true); return; }

        let totalOps = 1;
        totalOps += data.lists.length;
        data.lists.forEach(l => {
            totalOps += l.cards.length;
            l.cards.forEach(c => {
                if(c.color) totalOps++;
                totalOps += c.checklists.length;
                c.checklists.forEach(cl => totalOps += cl.items.length);
                totalOps += c.attachments.length;
            });
        });

        const confirmedName = prompt(`create board "${data.name}" in workspace "${wsName}"?\n(${totalOps} total api operations)`, data.name);
        if (!confirmedName) return;

        toggleSpinner(saveToTrelloBtn, true, 'saving...');

        let opsDone = 0;
        const updateProgress = () => {
            opsDone++;
            const percent = Math.round((opsDone / totalOps) * 100);
            showStatus(`saving... ${percent}% (${opsDone}/${totalOps} operations)`, false, 999999);
        };

        try {
            // "Personal Boards" is the editor's own label for boards outside any workspace, not a Trello id
            const workspaceField = wsId === 'personal' ? {} : { idOrganization: wsId };
            const newBoard = await trelloFetch('boards', { method: 'POST', body: JSON.stringify({ name: confirmedName, defaultLists: false, ...workspaceField }) });
            updateProgress();

            viewBoardLink.href = newBoard.url;
            boardLinkContainer.classList.remove('hidden');

            for (const list of data.lists) {
                const trelloList = await trelloFetch('lists', { method: 'POST', body: JSON.stringify({ name: list.name, idBoard: newBoard.id, pos: 'bottom' }) });
                updateProgress();
                for (const card of list.cards) {
                    const trelloCard = await trelloFetch('cards', { method: 'POST', body: JSON.stringify({ name: card.name, idList: trelloList.id, desc: card.desc.join('\n').trim(), pos: 'bottom' }) });
                    updateProgress();

                    if (card.color) {
                        await trelloFetch(`cards/${trelloCard.id}`, { method: 'PUT', body: JSON.stringify({ cover: { color: card.color } }) });
                        updateProgress();
                    }

                    for (const cl of card.checklists) {
                        const trelloCl = await trelloFetch(`cards/${trelloCard.id}/checklists`, { method: 'POST', body: JSON.stringify({ name: cl.name }) });
                        updateProgress();
                        for (const item of cl.items) {
                            await trelloFetch(`checklists/${trelloCl.id}/checkItems`, { method: 'POST', body: JSON.stringify({ name: item.name, checked: item.checked }) });
                            updateProgress();
                        }
                    }

                    for (const att of card.attachments) {
                        await trelloFetch(`cards/${trelloCard.id}/attachments`, { method: 'POST', body: JSON.stringify({ url: att.url, name: att.name }) });
                        updateProgress();
                    }
                }
            }
            showStatus(`success! board "${confirmedName}" created in "${wsName}".`);
            await loadBoards();
            workspaceSelector.value = wsId;
            populateBoards(wsId);
            boardSelector.value = newBoard.id;

        } catch (e) {
            showStatus("error: " + e.message, true);
            console.error(e);
        } finally {
            toggleSpinner(saveToTrelloBtn, false, 'Save to Trello <i class="fa-solid fa-cloud-arrow-up"></i>');
        }
    };

    // --- Board check ---
    const checkSummaryBtn = document.getElementById('check-summary-btn');
    const checkSummaryText = document.getElementById('check-summary-text');
    const checkModal = document.getElementById('check-modal');
    const checkResults = document.getElementById('check-results');
    const checkOriginalLabel = document.getElementById('check-original-label');
    const checkOriginalInput = document.getElementById('check-original-input');
    const copyCheckBtn = document.getElementById('copy-check-btn');
    const continueSaveBtn = document.getElementById('continue-save-btn');
    const closeCheckModalBtn = document.getElementById('close-check-modal-btn');
    let lastCheck = { problems: [], warnings: [], changes: [] };

    const boardTitle = (md) => (md.match(/^# (.+)$/m) || [])[1] || 'Board';

    const runCheck = () => {
        const markdown = editorAdapter.getMarkdown();
        lastCheck = checkBoardMarkdown(markdown, originalMarkdown);
        const hasContent = markdown.trim().length > 0;
        checkSummaryText.textContent = hasContent ? summarizeCheck(lastCheck) : 'Check';
        checkSummaryText.className = !hasContent ? 'text-gray-400'
            : lastCheck.problems.length ? 'text-red-400'
            : lastCheck.warnings.length ? 'text-yellow-400'
            : lastCheck.changes.length ? 'text-blue-300'
            : 'text-green-400';
        return lastCheck;
    };

    const setOriginal = (markdown, label) => {
        originalMarkdown = markdown;
        originalLabel = label;
        checkOriginalLabel.textContent = label;
        runCheck();
    };

    const renderCheckResults = (check) => {
        const block = (title, items, color) => items.length
            ? `<div><h3 class="text-xs font-bold uppercase tracking-wide mb-2 ${color}">${title}</h3>
                <ul class="list-disc ml-5 space-y-1 text-gray-300">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
            : '';
        checkResults.innerHTML = block('Problems: fix these before saving', check.problems, 'text-red-400')
            + block('Warnings: this content would be ignored', check.warnings, 'text-yellow-400')
            + block('Changes compared with the original', check.changes, 'text-blue-300')
            || '<p class="text-green-400">No problems found.</p>';
    };

    let checkOpenedForSave = false;
    const openCheckModal = (forSave) => {
        checkOpenedForSave = forSave;
        const check = runCheck();
        renderCheckResults(check);
        continueSaveBtn.classList.toggle('hidden', !forSave || check.problems.length > 0);
        checkModal.classList.remove('hidden');
    };

    // Save to Trello shows the check first unless there is nothing to report
    saveToTrelloBtn.addEventListener('click', () => {
        if (saveToTrelloBtn.disabled) return;
        const check = runCheck();
        if (check.problems.length || check.warnings.length || check.changes.length) openCheckModal(true);
        else saveToTrello();
    });

    checkSummaryBtn.addEventListener('click', () => openCheckModal(false));
    closeCheckModalBtn.addEventListener('click', () => checkModal.classList.add('hidden'));
    continueSaveBtn.addEventListener('click', () => {
        checkModal.classList.add('hidden');
        saveToTrello();
    });

    checkOriginalInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            setOriginal(evt.target.result, file.name);
            openCheckModal(checkOpenedForSave);
            checkOriginalInput.value = '';
        };
        reader.readAsText(file);
    });

    copyCheckBtn.addEventListener('click', async () => {
        const report = formatCheckReport(lastCheck, originalLabel);
        try {
            await navigator.clipboard.writeText(report);
        } catch (err) {
            showStatus("could not copy the report. select the text and copy it instead.", true);
            return;
        }
        const originalHtml = copyCheckBtn.innerHTML;
        copyCheckBtn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
        setTimeout(() => copyCheckBtn.innerHTML = originalHtml, 2000);
    });

    // Side by side: the Compare page opens with the original on the left and the editor's text on the right.
    // It reads this once and removes it (compare/compare.js).
    const COMPARE_HANDOFF_KEY = 'trello_tools_compare_handoff';
    document.querySelectorAll('[data-open-compare]').forEach(btn => btn.addEventListener('click', (e) => {
        e.preventDefault();
        const handoff = {
            left: { label: originalLabel ? `Original: ${originalLabel}` : 'Original', text: originalMarkdown || '' },
            right: { label: 'Editor', text: editorAdapter.getMarkdown() }
        };
        try {
            localStorage.setItem(COMPARE_HANDOFF_KEY, JSON.stringify(handoff));
        } catch (err) {
            showStatus("the board is too big to hand over. save both versions to files and open them in Compare.", true);
        }
        window.open('../compare/', '_blank', 'noopener');
    }));

    const init = async () => {
        if (trelloToken) {
            trelloConnectContainer.classList.add('hidden');
            trelloSelectionContainer.classList.remove('hidden');
            await loadBoards();
            loadMemberInfo();
        }

        // --- Deep Linking / Query Params Logic ---
        const params = new URLSearchParams(window.location.search);
        const urlParam = params.get('url');
        const viewParam = params.get('view');

        // 1. Handle URL Parameter
        if (urlParam) {
            urlInput.value = urlParam;
            await loadFromUrl();
        }

        // 2. Handle View Parameter
        if (viewParam) {
            const viewMap = {
                'md': 'markdown',
                'md-doc': 'split',
                'doc': 'wysiwyg',
                'md-board': 'split-board',
                'board': 'preview'
            };

            const targetMode = viewMap[viewParam.toLowerCase()];
            if (targetMode) {
                const targetBtn = Array.from(viewToggleBtns).find(btn => btn.dataset.mode === targetMode);
                if (targetBtn) {
                    targetBtn.click();
                }
            }
        }
    };
    init();
});