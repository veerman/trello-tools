"""Board Review: choose which boards the backup keeps.

Run: python review_boards.py
It opens a page listing every board in the backup's workspaces: who made it, who is on it and
your role, whether it is private, when it was last used, and its files. Boards that may be
personal are flagged (one member, private, email or personal-looking files). Mark each board In
or Out; every click is saved to board-choices.json in the backup folder. Boards with "roadmap" or
"phase <number>" in the name start as In.

When you stop the page, the boards and files are sorted into included and excluded folders (see
board_choices.py). backup.py then backs up only the In boards, and upload_to_drive.py uploads only
their files. A new board stays out until you mark it In.

The page is served only to this computer, at an address with a random key, while this script
runs. Board details are fetched fresh from Trello and never written to disk: board-choices.json
keeps the In boards' names and only the ids of Out boards.
"""
import http.server
import json
import re
import secrets
import sys
import threading
import webbrowser
from datetime import datetime, timezone

from backup import HERE, choose_workspaces, folder_setting, list_workspaces, setting, sort_boards, store_folder, trello_fetch
from board_choices import CHOICES_FILE, load_choices, save_choices, set_choice

REVIEW_QUERY = ("fields=name,shortUrl,dateLastActivity,idMemberCreator,prefs"
                "&members=all&member_fields=fullName,username&memberships=all"
                "&lists=open&list_fields=name&cards=open&card_fields=name"
                "&card_attachments=true&card_attachment_fields=name,bytes,mimeType,date,isUpload")

ROADMAP = re.compile(r'roadmap|phase\s*\d', re.I)
# Hints only, to point the eye: the page shows every file either way
EMAIL_FILE = re.compile(r'\.(eml|msg)$|^(re|fw|fwd)\s*:|^image\d{3}\.(png|jpe?g|gif)$|^outlook-', re.I)
PERSONAL_FILE = re.compile(r'r[eé]sum[eé]|\bcv\b|transcript|passport|\bvisa\b|permit|invoice|receipt|expense|reimburs'
                           r'|pay ?stub|payroll|\bt4\b|bank|cheque|direct deposit|contract|offer letter|signed|\btax|medical', re.I)


def created_from_id(board_id: str) -> str:
    """A Trello id starts with its creation time in seconds, as 8 hex digits."""
    return datetime.fromtimestamp(int(board_id[:8], 16), timezone.utc).strftime('%Y-%m-%d')


def file_hint(name: str):
    if EMAIL_FILE.search(name):
        return 'email'
    if PERSONAL_FILE.search(name):
        return 'personal'
    return None


def board_summary(board, me_id: str):
    """What the review page shows for one board, from Trello's board data."""
    members = {m['id']: m for m in board.get('members', [])}
    roles = {ms['idMember']: ms['memberType'] for ms in board.get('memberships', [])
             if not ms.get('deactivated') and ms['idMember'] in members}
    attachments = [a for card in board.get('cards', []) for a in card.get('attachments', [])]
    files = sorted(({'name': a['name'], 'size': a.get('bytes') or 0, 'date': (a.get('date') or '')[:10], 'hint': file_hint(a['name'])}
                    for a in attachments if a.get('isUpload')), key=lambda f: (f['date'], f['name'].lower()))
    creator = members.get(board.get('idMemberCreator'))
    visibility = (board.get('prefs') or {}).get('permissionLevel', '')

    flags = []
    if len(roles) == 1:
        flags.append('Only 1 member')
    if visibility == 'private':
        flags.append('Private board')
    emails = sum(1 for f in files if f['hint'] == 'email')
    if emails:
        flags.append(f"{emails} email attachment{'s' if emails > 1 else ''}")
    personal = sum(1 for f in files if f['hint'] == 'personal')
    if personal:
        flags.append(f"{personal} personal-looking file{'s' if personal > 1 else ''}")

    return {
        'id': board['id'],
        'name': board['name'],
        'url': board.get('shortUrl', ''),
        'created': created_from_id(board['id']),
        'last_activity': (board.get('dateLastActivity') or '')[:10],
        'made_by': creator['fullName'] if creator else 'someone no longer on the board',
        'your_role': roles.get(me_id, 'not a member'),
        'visibility': visibility,
        'members': sorted(({'name': members[mid]['fullName'], 'role': role} for mid, role in roles.items()),
                          key=lambda m: (m['role'] != 'admin', m['name'].lower())),
        'lists': [lst['name'] for lst in board.get('lists', [])],
        'cards': len(board.get('cards', [])),
        'files': files,
        'links': len(attachments) - len(files),
        'flags': flags,
        'roadmap': bool(ROADMAP.search(board['name'])),
    }


def start_roadmaps_as_in(boards, choices) -> int:
    """Boards not reviewed yet whose name says roadmap or phase start as In. Returns how many."""
    started = 0
    for board in boards:
        if board['roadmap'] and board['id'] not in choices['in'] and board['id'] not in choices['out']:
            set_choice(choices, board['id'], board['name'], 'in')
            started += 1
    return started


def make_server(boards, choices, backup_dir, page: bytes):
    """The review page and its two calls, for this computer only, under a random key."""
    key = secrets.token_urlsafe(16)
    by_id = {board['id']: board for board in boards}
    lock = threading.Lock()

    class Handler(http.server.BaseHTTPRequestHandler):
        def send(self, status, body: bytes, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', f'{content_type}; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == f'/{key}/':
                self.send(200, page, 'text/html')
            elif self.path == f'/{key}/boards':
                with lock:
                    listed = [{**board, 'choice': 'in' if board['id'] in choices['in'] else 'out' if board['id'] in choices['out'] else None}
                              for board in boards]
                self.send(200, json.dumps(listed).encode())
            else:
                self.send(404, b'{}')

        def do_POST(self):
            # JSON only: another website can't send that to this page without the browser asking first
            if self.path != f'/{key}/choice' or not self.headers.get('Content-Type', '').startswith('application/json'):
                self.send(404, b'{}')
                return
            try:
                request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                board = by_id[request['id']]
                if request['choice'] not in ('in', 'out', None):
                    raise ValueError
            except (ValueError, KeyError, TypeError):
                self.send(400, b'{"error": "bad request"}')
                return
            with lock:
                set_choice(choices, board['id'], board['name'], request['choice'])
                save_choices(backup_dir, choices)
            self.send(200, b'{"saved": true}')

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    return server, f'http://127.0.0.1:{server.server_address[1]}/{key}/'


def main():
    if not setting('TRELLO_API_KEY') or not setting('TRELLO_API_TOKEN'):
        print("Error: set TRELLO_API_KEY and TRELLO_API_TOKEN in .env (see .env.example).")
        return 1
    backup_dir = folder_setting('BACKUP_DIR', 'backup')
    workspaces = list_workspaces()
    chosen = choose_workspaces(workspaces)
    listed = [(ws, board) for ws in chosen for board in sorted(workspaces[ws], key=lambda b: b['name'].lower())]
    if not listed:
        print("No boards to review.")
        return 1

    me_id = trello_fetch('members/me?fields=id')['id']
    boards = []
    for i, (ws, board) in enumerate(listed, 1):
        print(f"\rReading boards from Trello: {i}/{len(listed)}", end='', flush=True)
        boards.append({**board_summary(trello_fetch(f"boards/{board['id']}?{REVIEW_QUERY}"), me_id), 'workspace': ws})
    print()

    choices = load_choices(backup_dir) or {'in': {}, 'out': []}
    started = start_roadmaps_as_in(boards, choices)
    if started:
        save_choices(backup_dir, choices)
    flagged = sum(1 for board in boards if board['flags'])
    print(f"{len(boards)} boards, {flagged} flagged. {started} roadmap boards newly marked In.")
    server, url = make_server(boards, choices, backup_dir, (HERE / 'review_boards.html').read_bytes())
    print(f"Review page: {url}")
    print(f"Every click is saved to {backup_dir / CHOICES_FILE}. Press Ctrl+C here when you're done.")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDone. Your choices are saved. Sorting the boards and files into included and excluded:")
        sort_boards(backup_dir, store_folder(backup_dir), choices)
    return 0


if __name__ == "__main__":
    sys.exit(main())
