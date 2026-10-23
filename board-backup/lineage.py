"""Board Lineage: group the backed-up boards into lines, one per board that is re-issued over time.

Run: python lineage.py
It opens a page with every board in the backup folder. Put the boards that are versions of the same
board (the same roadmap re-issued every term under a new name, say) into one line, oldest first;
mark drafts and test copies as side boards; and note when a line started from another line's
board. The page suggests lines from similar names and shared card titles, and puts any two
versions side by side. Every change is saved to lineage.json in the backup folder.

Then: python lineage.py --history
For each line without a history file yet, writes history/<line>.md one version at a time, oldest
first, with one git commit per version dated when that board was created. The file's git history
(git log -p, or History on GitHub) then shows every change from version to version. After that,
each backup run keeps the file at the line's newest board, so new changes show up as ordinary
commits.

Works from the backup folder only: nothing is fetched from Trello. The page is served only to this
computer, at an address with a random key, while this script runs.
"""
import http.server
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

from backup import HERE, folder_setting, sanitize_filename

LINEAGE_FILE = 'lineage.json'
HISTORY_DIR = 'history'
# The Compare view from the browser tools, served to the page as is
SHARED_FILES = {'diff.js': 'text/javascript', 'compare-view.js': 'text/javascript', 'compare.css': 'text/css'}

FRONT_MATTER = re.compile(r'\A---\n(.*?)\n---\n', re.S)
# Parts of a name that change from version to version: term codes (W2025, S25), years, seasons
TERM_WORDS = re.compile(r'\b(?:[wsf](?:20)?\d{2}|20\d{2}|winter|spring|summer|fall|autumn)\b', re.I)
# Names that mark a draft or a copy rather than the version in use
SIDE_WORDS = re.compile(r'\b(?:wip|draft|copy|test|testing|staging|old|backup|sandbox)\b', re.I)


# --- Boards in the backup folder ---

def read_board(path: Path):
    """One board file's details (from the block at its top), name, and card titles."""
    text = path.read_text(encoding='utf-8')
    details = {}
    match = FRONT_MATTER.match(text)
    if match:
        for line in match.group(1).splitlines():
            key, _, value = line.partition(':')
            value = value.strip()
            details[key.strip()] = json.loads(value) if value.startswith('"') else value
    body = text[match.end():] if match else text
    lines = body.splitlines()
    name = next((line[2:].strip() for line in lines if line.startswith('# ')), path.stem)
    titles = [re.sub(r'\s*\[[a-z_]*\]\s*$', '', line[4:]).strip() for line in lines if line.startswith('### ')]
    return {
        'id': details.get('trello_board', ''), 'name': name, 'file': path.name,
        'url': details.get('url', ''), 'workspace': details.get('workspace', ''),
        'created': details.get('created', ''), 'last_activity': details.get('last_activity', ''),
        'cards': len(titles), 'titles': titles, 'base_name': base_name(name),
    }


def list_boards(backup_dir: Path):
    """Every board in the backup, oldest first."""
    boards = [read_board(path) for path in sorted((backup_dir / 'boards').glob('*.md'))]
    return sorted((b for b in boards if b['id']), key=lambda b: (b['created'], b['name'].lower()))


def name_key(name: str) -> str:
    """A name without term codes, years, and draft words, so versions of one board match."""
    key = SIDE_WORDS.sub(' ', TERM_WORDS.sub(' ', name.lower()))
    return ' '.join(re.sub(r'[^\w]+', ' ', key).split())


def base_name(name: str) -> str:
    """A name for a line, from one of its boards: the name without term codes and years."""
    tidy = ' '.join(TERM_WORDS.sub(' ', name).split()).strip(' -:|,')
    return tidy or name


# --- The lineage file ---

def clean_lineage(data, boards_by_id, strict=True):
    """The lineage checked against the boards: each line has its own name, and each board is known
    and in one line at most. Board names are refreshed from the board files, so renames show up.

    strict (what the page sends): anything wrong is an error. Otherwise (the saved file): boards no
    longer in the backup, such as ones marked Out since, are dropped. Returns (lineage, dropped)."""
    lines, seen, names, dropped = [], set(), set(), 0

    def known(board_id):
        nonlocal dropped
        if board_id in boards_by_id:
            return True
        if strict:
            raise ValueError(f'unknown board {board_id!r}')
        dropped += 1
        return False

    for line in data.get('lines', []):
        name = str(line.get('name', '')).strip()
        if not name or name.lower() in names:
            raise ValueError(f'each line needs a name of its own: {name!r}')
        names.add(name.lower())
        boards = []
        for entry in line.get('boards', []):
            board_id = entry.get('id')
            if not known(board_id):
                continue
            if board_id in seen:
                raise ValueError(f'{boards_by_id[board_id]["name"]!r} is in more than one line')
            seen.add(board_id)
            boards.append({'id': board_id, 'name': boards_by_id[board_id]['name'], **({'side': True} if entry.get('side') else {})})
        cleaned = {'name': name, 'boards': boards}
        started = line.get('started_from')
        started = started.get('id') if isinstance(started, dict) else started
        if started and known(started):
            if started in {b['id'] for b in boards}:
                raise ValueError(f'{name!r} cannot start from one of its own boards')
            cleaned['started_from'] = {'id': started, 'name': boards_by_id[started]['name']}
        lines.append(cleaned)
    return {'lines': lines}, dropped


def load_lineage(backup_dir: Path, boards_by_id):
    """The saved lineage, without boards that have left the backup. Returns (lineage, dropped)."""
    path = backup_dir / LINEAGE_FILE
    if not path.exists():
        return {'lines': []}, 0
    return clean_lineage(json.loads(path.read_text(encoding='utf-8')), boards_by_id, strict=False)


def save_lineage(backup_dir: Path, lineage):
    (backup_dir / LINEAGE_FILE).write_text(json.dumps(lineage, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')


def suggest_lines(boards, lineage):
    """Groups of boards not in a line yet that look like versions of one board: the same name once
    term codes and years are gone, or mostly the same card titles. Oldest first; drafts, copies,
    and tests start as side boards."""
    placed = {b['id'] for line in lineage['lines'] for b in line['boards']}
    free = [b for b in boards if b['id'] not in placed]
    group = {b['id']: b['id'] for b in free}

    def root(board_id):
        while group[board_id] != board_id:
            board_id = group[board_id]
        return board_id

    titles = {b['id']: {' '.join(re.sub(r'[^\w]+', ' ', t.lower()).split()) for t in b['titles']} for b in free}
    for i, a in enumerate(free):
        for b in free[i + 1:]:
            same_name = name_key(a['name']) and name_key(a['name']) == name_key(b['name'])
            ta, tb = titles[a['id']], titles[b['id']]
            similar = len(ta) >= 5 and len(tb) >= 5 and len(ta & tb) / len(ta | tb) >= 0.6
            if same_name or similar:
                group[root(a['id'])] = root(b['id'])

    groups = {}
    for board in free:
        groups.setdefault(root(board['id']), []).append(board)
    suggestions = []
    for members in groups.values():
        if len(members) < 2:
            continue
        main = [b for b in members if not SIDE_WORDS.search(b['name'])] or members
        suggestions.append({'name': base_name(main[-1]['name']),
                            'boards': [{'id': b['id'], **({'side': True} if SIDE_WORDS.search(b['name']) else {})} for b in members]})
    return sorted(suggestions, key=lambda s: s['name'].lower())


# --- History files ---

def history_path(backup_dir: Path, line) -> Path:
    return backup_dir / HISTORY_DIR / f"{sanitize_filename(line['name'])}.md"


def versions(line, boards_by_id):
    """The boards a line's history goes through, oldest first: the board it started from, if any,
    then its main boards (side boards stay out)."""
    ids = ([line['started_from']['id']] if line.get('started_from') else []) + [b['id'] for b in line['boards'] if not b.get('side')]
    return [boards_by_id[i] for i in ids if i in boards_by_id]


def board_bytes(backup_dir: Path, board) -> bytes:
    return (backup_dir / 'boards' / board['file']).read_bytes()


def update_history(backup_dir: Path):
    """For backup.py, after a run: each line's history file is set to the line's newest board.
    Returns (updated, without_history): line names, the second for lines --history hasn't built."""
    boards_by_id = {b['id']: b for b in list_boards(backup_dir)}
    lineage, _ = load_lineage(backup_dir, boards_by_id)
    updated, without = [], []
    for line in lineage['lines']:
        steps = versions(line, boards_by_id)
        if not steps:
            continue
        path = history_path(backup_dir, line)
        if not path.exists():
            without.append(line['name'])
            continue
        newest = board_bytes(backup_dir, steps[-1])
        if path.read_bytes() != newest:
            path.write_bytes(newest)
            updated.append(line['name'])
    return updated, without


def git(backup_dir: Path, *args, date=None):
    env = {**os.environ, **({'GIT_AUTHOR_DATE': date} if date else {})}
    return subprocess.run(['git', '-C', str(backup_dir), *args], check=True, capture_output=True, text=True, env=env).stdout


def plan_history(backup_dir: Path):
    """[(line, versions)] for the lines that have no history file yet."""
    boards_by_id = {b['id']: b for b in list_boards(backup_dir)}
    lineage, _ = load_lineage(backup_dir, boards_by_id)
    return [(line, versions(line, boards_by_id)) for line in lineage['lines']
            if versions(line, boards_by_id) and not history_path(backup_dir, line).exists()]


def make_history(backup_dir: Path, plan) -> int:
    """Writes each planned line's history file one version at a time, committing each version with
    the date its board was created. Commits only the history files. Returns how many commits."""
    commits = 0
    for line, steps in plan:
        path = history_path(backup_dir, line)
        path.parent.mkdir(exist_ok=True)
        relative = path.relative_to(backup_dir).as_posix()
        for board in steps:
            path.write_bytes(board_bytes(backup_dir, board))
            git(backup_dir, 'add', '--', relative)
            if not git(backup_dir, 'status', '--porcelain', '--', relative).strip():
                continue  # the same as the version before
            created = board['created'] or '1970-01-01'
            git(backup_dir, 'commit', '-q', '-m', f"{line['name']}: {board['name']}", '--', relative, date=f'{created}T12:00:00Z')
            commits += 1
    return commits


# --- The page ---

def make_server(backup_dir: Path, page: bytes):
    """The lineage page and its calls, for this computer only, under a random key."""
    key = secrets.token_urlsafe(16)
    lock = threading.Lock()
    shared = HERE.parent / 'shared'

    def current():
        boards = list_boards(backup_dir)
        by_id = {b['id']: b for b in boards}
        lineage, dropped = load_lineage(backup_dir, by_id)
        return boards, by_id, lineage, dropped

    class Handler(http.server.BaseHTTPRequestHandler):
        def send(self, status, body: bytes, content_type='application/json'):
            self.send_response(status)
            self.send_header('Content-Type', f'{content_type}; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path
            if path == f'/{key}/':
                self.send(200, page, 'text/html')
            elif path == f'/{key}/data':
                with lock:
                    boards, _, lineage, dropped = current()
                listed = [{k: v for k, v in b.items() if k != 'titles'} for b in boards]
                self.send(200, json.dumps({'boards': listed, 'lineage': lineage, 'dropped': dropped,
                                           'suggestions': suggest_lines(boards, lineage)}).encode())
            elif path.startswith(f'/{key}/board/'):
                with lock:
                    board = current()[1].get(path.rsplit('/', 1)[1])
                if board:
                    self.send(200, board_bytes(backup_dir, board), 'text/markdown')
                else:
                    self.send(404, b'{}')
            elif path.startswith(f'/{key}/shared/') and path.rsplit('/', 1)[1] in SHARED_FILES:
                name = path.rsplit('/', 1)[1]
                self.send(200, (shared / name).read_bytes(), SHARED_FILES[name])
            else:
                self.send(404, b'{}')

        def do_POST(self):
            # JSON only: another website can't send that to this page without the browser asking first
            if self.path != f'/{key}/lineage' or not self.headers.get('Content-Type', '').startswith('application/json'):
                self.send(404, b'{}')
                return
            with lock:
                boards, by_id, _, _ = current()
                try:
                    lineage, _ = clean_lineage(json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))), by_id)
                except (ValueError, KeyError, TypeError, AttributeError) as e:
                    self.send(400, json.dumps({'error': str(e)}).encode())
                    return
                save_lineage(backup_dir, lineage)
            self.send(200, json.dumps({'lineage': lineage, 'suggestions': suggest_lines(boards, lineage)}).encode())

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    return server, f'http://127.0.0.1:{server.server_address[1]}/{key}/'


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    backup_dir = folder_setting('BACKUP_DIR', 'backup')
    if not (backup_dir / 'boards').is_dir():
        print(f"No boards in {backup_dir}. Run python backup.py first.")
        return 1

    if '--history' in argv:
        plan = plan_history(backup_dir)
        if not plan:
            print("Every line already has a history file (or there are no lines yet: run python lineage.py).")
            return 0
        try:
            git(backup_dir, 'rev-parse', '--is-inside-work-tree')
        except (subprocess.CalledProcessError, FileNotFoundError):
            print(f"{backup_dir} is not a git repository, so there is no history to write into.")
            return 1
        print("History to write, one commit per version, oldest first:")
        for line, steps in plan:
            print(f"\n  {history_path(backup_dir, line).relative_to(backup_dir).as_posix()}")
            for board in steps:
                print(f"    {board['created']}  {board['name']}")
        if input(f"\nMake these commits in {backup_dir}? Nothing is pushed. [y/N] ").strip().lower() != 'y':
            print("Nothing written.")
            return 0
        print(f"Done: {make_history(backup_dir, plan)} commits. See them with: git log -p -- {HISTORY_DIR}/")
        return 0

    server, url = make_server(backup_dir, (HERE / 'lineage.html').read_bytes())
    print(f"Lineage page: {url}")
    print(f"Every change is saved to {backup_dir / LINEAGE_FILE}. Press Ctrl+C here when you're done.")
    webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDone. Your lines are saved. To build their history files: python lineage.py --history")
    return 0


if __name__ == "__main__":
    sys.exit(main())
