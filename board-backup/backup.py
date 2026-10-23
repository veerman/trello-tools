"""Board Backup: saves every board in the chosen workspaces as one Markdown file, and every
attachment once in the file store, named by its fingerprint.

Run: python backup.py
Settings come from .env next to this script (see .env.example). Every run fetches every board
again; put the backup folder in git and it records only what changed. Once you have chosen
boards with review_boards.py, only the boards marked In are backed up, and each run first moves
any board whose choice changed (and its files) to the right side: see board_choices.py.
"""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

import board_markdown
import env
from board_choices import apply_choices, check_folders, keep_chosen, load_choices
from file_store import FileStore

env.load_env()
HERE = Path(__file__).resolve().parent

# The most comments Trello sends in one request; busier boards are fetched in pages (fetch_board)
COMMENT_PAGE = 1000
BOARD_QUERY = ("fields=name,shortUrl,dateLastActivity&organization=true&organization_fields=displayName"
               "&lists=open&cards=open&checklists=all&card_attachments=true"
               f"&actions=commentCard&actions_limit={COMMENT_PAGE}")


def setting(name: str) -> str:
    return os.environ.get(name, '').strip()


def folder_setting(name: str, default: str) -> Path:
    """A folder from .env. Relative paths are relative to this script's folder."""
    path = Path(setting(name) or default)
    return path if path.is_absolute() else (HERE / path).resolve()


def store_folder(backup_dir: Path) -> Path:
    """FILE_STORE from .env, or files/ inside the backup folder (kept out of git there)."""
    return folder_setting('FILE_STORE', str(backup_dir / 'files'))


def trello_fetch(endpoint):
    separator = '&' if '?' in endpoint else '?'
    url = f"https://api.trello.com/1/{endpoint}{separator}key={setting('TRELLO_API_KEY')}&token={setting('TRELLO_API_TOKEN')}"
    for attempt in range(2):
        try:
            with urllib.request.urlopen(urllib.request.Request(url), timeout=60) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            # Trello's rate limit: wait and try once more
            if e.code == 429 and attempt == 0:
                time.sleep(10)
                continue
            raise RuntimeError(f"API Error {e.code}: {e.read().decode()}")


def fetch_board(board_id, fetch=None):
    """The board with every comment. Trello sends the newest comments first, at most COMMENT_PAGE
    at a time, so while a page comes back full the next one asks for the comments before its last."""
    fetch = fetch or trello_fetch
    board_data = fetch(f"boards/{board_id}?{BOARD_QUERY}")
    page = board_data.get('actions', [])
    while len(page) == COMMENT_PAGE:
        last = page[-1]['id']
        page = fetch(f"boards/{board_id}/actions?filter=commentCard&limit={COMMENT_PAGE}&before={last}")
        # Stop if Trello ever sends the same page again, rather than loop
        if not page or page[-1]['id'] == last:
            break
        board_data['actions'].extend(page)
    return board_data


def sanitize_filename(name):
    return re.sub(r'[<>:"/\\|?*]', '', name).strip()


def list_workspaces():
    """{workspace name: [boards]} for every open board you are a member of."""
    boards = trello_fetch('members/me/boards?filter=open&fields=name&organization=true&organization_fields=displayName')
    workspaces = {}
    for board in boards:
        name = (board.get('organization') or {}).get('displayName') or 'Personal Boards'
        workspaces.setdefault(name, []).append(board)
    return workspaces


def choose_workspaces(workspaces):
    wanted = [name.strip() for name in setting('BACKUP_WORKSPACES').split(',') if name.strip()]
    if wanted:
        for name in wanted:
            if name not in workspaces:
                print(f"Warning: no workspace named {name!r}. Check BACKUP_WORKSPACES in .env.")
        return [name for name in wanted if name in workspaces]

    names = sorted(workspaces, key=str.lower)
    print("\nWorkspaces:")
    for i, name in enumerate(names, 1):
        print(f"  {i}. {name} ({len(workspaces[name])} boards)")
    answer = input("\nWhich ones? Numbers separated by commas, or 'all': ").strip().lower()
    if answer == 'all':
        chosen = names
    else:
        picks = [int(part) for part in answer.split(',') if part.strip().isdigit()]
        chosen = [names[n - 1] for n in picks if 0 < n <= len(names)]
    if chosen:
        print(f"\nTip: add BACKUP_WORKSPACES={','.join(chosen)} to .env to skip this question.")
    return chosen


def sort_boards(backup_dir: Path, store_dir: Path, choices):
    """Moves boards and files whose choice changed to the right side (see board_choices.py)."""
    excluded_dir = folder_setting('EXCLUDED_DIR', 'excluded')
    moved = apply_choices(choices, backup_dir, store_dir, excluded_dir)
    print(f"Excluded:      {excluded_dir} ({moved['files_out']} files, this computer only)")
    if moved['boards_out'] or moved['moved_out']:
        print(f"  Moved to the excluded folder: {moved['boards_out']} boards, {moved['moved_out']} files")
    if moved['boards_back'] or moved['moved_back']:
        print(f"  Moved back from the excluded folder: {moved['boards_back']} boards, {moved['moved_back']} files")


def write_board_file(boards_dir: Path, board_data, markdown: str) -> Path:
    """boards/<board name> [<board id>].md (the workspace is in the file's details block). A
    renamed board replaces its old file, so git sees a rename rather than a new board; a file in
    a workspace folder from older backups moves up the same way."""
    target = boards_dir / f"{sanitize_filename(board_data['name'])} [{board_data['id']}].md"
    for old in list(boards_dir.rglob("*.md")):
        if old.name.endswith(f"[{board_data['id']}].md") and old != target:
            old.unlink()
            if old.parent != boards_dir and not any(old.parent.iterdir()):
                old.parent.rmdir()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(markdown, encoding='utf-8', newline='\n')
    return target


def main():
    if not setting('TRELLO_API_KEY') or not setting('TRELLO_API_TOKEN'):
        print("Error: set TRELLO_API_KEY and TRELLO_API_TOKEN in .env (see .env.example).")
        return 1

    backup_dir = folder_setting('BACKUP_DIR', 'backup')
    store_dir = store_folder(backup_dir)
    print(f"Backup folder: {backup_dir}\nFile store:    {store_dir}")
    check_folders(backup_dir, store_dir)
    choices = load_choices(backup_dir)
    if choices is not None:
        sort_boards(backup_dir, store_dir, choices)
    store = FileStore(store_dir, backup_dir / 'attachments.json')

    workspaces = list_workspaces()
    chosen = choose_workspaces(workspaces)
    boards = [(ws, board) for ws in chosen for board in sorted(workspaces[ws], key=lambda b: b['name'].lower())]
    boards, left_out, not_reviewed = keep_chosen(boards, choices)
    if left_out or not_reviewed:
        print(f"Board choices: {len(boards)} In, {left_out} Out, {not_reviewed} not reviewed (left out).")
    if not boards:
        print("Nothing to back up.")
        return 1

    failed_boards = []
    for i, (ws, board) in enumerate(boards, 1):
        print(f"[{i}/{len(boards)}] {ws} / {board['name']}")
        try:
            board_data = fetch_board(board['id'])
            lists_and_cards = board_markdown.open_lists_and_cards(board_data)
            fingerprints = store.record_board(board_data, lists_and_cards)
            write_board_file(backup_dir / 'boards', board_data, board_markdown.board_to_markdown(board_data, fingerprints))
        except Exception as e:
            print(f"  Failed: {e}")
            failed_boards.append(board['name'])
        # Saved after every board, so a stopped run keeps everything done so far
        store.save()
    store.set_dates()

    print(f"\nDone: {len(boards) - len(failed_boards)} of {len(boards)} boards saved.")
    print(f"Files: {store.downloaded} downloaded, {store.reused} already in the store.")
    for name in failed_boards:
        print(f"  Board failed: {name}")
    for failure in store.failures:
        print(f"  File not stored: {failure['name']} ({failure['url']}): {failure['error']}")
    if not_reviewed:
        print(f"{not_reviewed} boards haven't been reviewed, so they were left out. To choose: python review_boards.py")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nStopped. Every board finished so far is saved.")
        sys.exit(1)
