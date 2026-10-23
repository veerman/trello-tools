"""Trello board JSON in, Markdown out (see board-editor/trello-markdown-guide.md).

Must match boardToMarkdown in board-editor/script.js, plus the two things only the backup
knows: card comments and the fingerprints of stored attachments.
"""
import json
import re
from datetime import datetime, timezone


def process_description(desc):
    if not desc:
        return ""

    clean_desc = re.sub(r'[​-‍﻿]', '', desc)
    clean_desc = re.sub(r'(?:\r?\n[ \t]*){2,}', '\n\n', clean_desc).strip()

    def header_replacer(match):
        text = match.group(2)
        text = re.sub(r'^\*\*|\*\*$', '', text).strip()
        return f"**{text}**"

    safe_desc = re.sub(r'^(#{1,6})\s+(.*)$', header_replacer, clean_desc, flags=re.MULTILINE)

    lines = safe_desc.split('\n')
    filtered_lines = []

    for i, line in enumerate(lines):
        if line.strip() != '':
            filtered_lines.append(line)
            continue

        prev_line = lines[i - 1] if i > 0 else ''
        next_line = lines[i + 1] if i < len(lines) - 1 else ''

        is_prev_list = bool(re.match(r'^\s*\d+\.\s', prev_line))
        is_next_list = bool(re.match(r'^\s*\d+\.\s', next_line))

        if not (is_prev_list and is_next_list):
            filtered_lines.append(line)

    list_counter = 1
    final_lines = []

    for line in filtered_lines:
        list_match = re.match(r'^(\s*)\d+\.\s(.*)$', line)
        if list_match:
            final_lines.append(f"{list_match.group(1)}{list_counter}. {list_match.group(2)}")
            list_counter += 1
        else:
            if line.strip() != '':
                list_counter = 1
            final_lines.append(line)

    return '\n'.join(final_lines)


def front_matter(board_data):
    """The board's own details (id, link, workspace, dates) as a block at the top of the file.

    Not board content: the editor skips it on Save to Trello. Must match frontMatter in
    board-editor/script.js."""
    board_id = board_data.get('id') or ''
    lines = []
    if board_id:
        lines.append(f"trello_board: {board_id}")
    if board_data.get('shortUrl'):
        lines.append(f"url: {board_data['shortUrl']}")
    workspace = (board_data.get('organization') or {}).get('displayName')
    if workspace:
        lines.append(f"workspace: {json.dumps(workspace, ensure_ascii=False)}")
    # A Trello id starts with its creation time in seconds, as 8 hex digits
    if re.fullmatch(r'[0-9a-f]{24}', board_id):
        created = datetime.fromtimestamp(int(board_id[:8], 16), tz=timezone.utc)
        lines.append(f"created: {created:%Y-%m-%d}")
    if board_data.get('dateLastActivity'):
        lines.append(f"last_activity: {board_data['dateLastActivity'][:10]}")
    return "---\n" + "\n".join(lines) + "\n---\n\n" if lines else ""


def open_lists_and_cards(board_data):
    """[(list, [cards])] in board order. Archived lists and cards are left out, so a re-import
    can't bring them back."""
    open_lists = sorted((lst for lst in board_data.get('lists', []) if not lst.get('closed')),
                        key=lambda x: x.get('pos', 0))
    cards_by_list = {}
    for card in board_data.get('cards', []):
        if not card.get('closed'):
            cards_by_list.setdefault(card['idList'], []).append(card)
    return [(lst, sorted(cards_by_list.get(lst['id'], []), key=lambda x: x.get('pos', 0))) for lst in open_lists]


def board_to_markdown(board_data, fingerprints=None):
    """fingerprints maps attachment URLs to the fingerprints of their stored files."""
    fingerprints = fingerprints or {}
    md = f"{front_matter(board_data)}# {board_data['name']}\n\n"

    comments_by_card = {}
    for action in board_data.get('actions', []):
        if action.get('type') == 'commentCard':
            c_id = action.get('data', {}).get('card', {}).get('id')
            if c_id:
                comments_by_card.setdefault(c_id, []).append(action)

    for lst, list_cards in open_lists_and_cards(board_data):
        md += f"## {lst['name']}\n\n"

        for card in list_cards:
            color = (card.get('cover') or {}).get('color')
            color_tag = f" [{color}]" if color else " []"
            md += f"### {card['name']}{color_tag}\n\n"

            if card.get('desc'):
                safe_desc = process_description(card['desc'])
                md += f"{safe_desc}\n\n"

            checklists = [cl for cl in board_data.get('checklists', []) if cl.get('idCard') == card['id']]
            checklists = sorted(checklists, key=lambda x: x.get('pos', 0))

            for cl in checklists:
                cl_name = cl.get('name') or 'Checklist'
                md += f"#### {cl_name}\n"
                items = sorted(cl.get('checkItems', []), key=lambda x: x.get('pos', 0))
                for item in items:
                    tick = "[x] " if item.get('state') == 'complete' else ""
                    md += f"- {tick}{item['name']}\n"
                md += "\n"

            attachments = card.get('attachments', [])
            if attachments:
                md += "##### Attachments\n"
                for att in attachments:
                    raw_name = att.get('name') or att.get('url')
                    safe_name = raw_name.replace('[', '\\[').replace(']', '\\]')
                    safe_url = att['url'].replace('(', '%28').replace(')', '%29')
                    # The same fingerprint on two boards means the same file, whatever the link
                    fingerprint = fingerprints.get(att['url'])
                    title = f' "sha256:{fingerprint}"' if fingerprint else ''
                    md += f"- [{safe_name}]({safe_url}{title})\n"
                md += "\n"

            card_comments = comments_by_card.get(card['id'], [])
            if card_comments:
                card_comments = sorted(card_comments, key=lambda x: x.get('date', ''))
                # H6 so the editor skips it: comments are kept for reference, never recreated
                md += "###### Comments\n"
                for c in card_comments:
                    creator = c.get('memberCreator', {})
                    full_name = creator.get('fullName', 'Unknown')
                    username = creator.get('username', 'unknown')
                    date_str = c.get('date', '')[:10]
                    text = c.get('data', {}).get('text', '')

                    if text:
                        safe_text = process_description(text)
                        md += f"**{full_name}** (@{username}) - {date_str}:\n{safe_text}\n\n"

    return md
