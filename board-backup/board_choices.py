"""Which boards the backup keeps, and keeping included and excluded boards apart.

A board is included only when it is marked In with review_boards.py; every other board is
excluded. Included boards live in the backup folder (the git repo), and their files in the file
store (files/ inside it by default, kept out of git; copied to Drive). Excluded boards and their
files live in the excluded folder (EXCLUDED_DIR), which stays on this computer: never in git,
never copied to Drive.

A file belongs to every board it has been on. A file used on an included board is included; if
an excluded board uses it too, the excluded folder gets its own copy, so each side is complete
on its own and never refers to the other. A file whose boards aren't known is excluded.

When a choice changes, apply_choices moves the board's last copy and its files to the other side.
"""
import json
import shutil
import subprocess
from pathlib import Path

from file_store import FileStore

CHOICES_FILE = 'board-choices.json'
EXCLUDED_README = """Excluded boards

The boards in this folder are not marked In (see review_boards.py), so they are left out of the
backup. Their last copies and their files are kept here, on this computer only: this folder is
never put in git and never copied to Google Drive. Delete it whenever you like.
"""


def load_choices(backup_dir: Path):
    """The boards chosen with review_boards.py: {'in': {id: name}, 'out': [ids]}, or None before
    the first review."""
    path = backup_dir / CHOICES_FILE
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding='utf-8'))
    return {'in': dict(data.get('in', {})), 'out': list(data.get('out', []))}


def set_choice(choices, board_id: str, name: str, choice):
    """choice is 'in', 'out', or None (not reviewed)."""
    choices['in'].pop(board_id, None)
    choices['out'] = [b for b in choices['out'] if b != board_id]
    if choice == 'in':
        choices['in'][board_id] = name
    elif choice == 'out':
        choices['out'].append(board_id)


def save_choices(backup_dir: Path, choices):
    data = {
        'about': "Boards the backup keeps, chosen with review_boards.py. Out boards are listed by id only.",
        'in': dict(sorted(choices['in'].items(), key=lambda item: (item[1].lower(), item[0]))),
        'out': sorted(choices['out']),
    }
    path = backup_dir / CHOICES_FILE
    part = path.with_name(path.name + '.part')
    part.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
    part.replace(path)


def keep_chosen(boards, choices):
    """(boards marked In, how many are Out, how many haven't been reviewed). Without a review,
    every board is kept."""
    if choices is None:
        return boards, 0, 0
    kept = [(ws, board) for ws, board in boards if board['id'] in choices['in']]
    out = sum(1 for _, board in boards if board['id'] in choices['out'])
    return kept, out, len(boards) - len(kept) - out


def file_boards(entry) -> set:
    """Every board a file or link is on, or has been on."""
    return {place['board_id'] for place in entry.get('used_in', [])} | set(entry.get('seen_on', []))


def is_inside(path: Path, folder: Path) -> bool:
    return path == folder or folder in path.parents


def check_folders(backup_dir: Path, store_dir: Path, excluded_dir: Path = None):
    """The file store may be inside the backup folder, kept out of git there. The excluded folder
    must be apart from both, so excluded boards never end up in git or on Drive."""
    backup, store = Path(backup_dir).resolve(), Path(store_dir).resolve()
    if is_inside(backup, store):
        raise ValueError(f"The backup folder {backup} can't be inside the file store {store}")
    if excluded_dir is not None:
        excluded = Path(excluded_dir).resolve()
        for other in (backup, store):
            if is_inside(excluded, other) or is_inside(other, excluded):
                raise ValueError(f"{excluded} and {other} overlap: the excluded folder must be separate from the backup folder and the file store")
    if is_inside(store, backup):
        keep_out_of_git(backup, store)


def keep_out_of_git(backup: Path, store: Path):
    """Lists a file store inside the backup folder in that folder's .gitignore, and checks that
    git agrees, so the files themselves can never be committed."""
    relative = store.relative_to(backup).as_posix()
    ignore = backup / '.gitignore'
    lines = ignore.read_text(encoding='utf-8').splitlines() if ignore.exists() else []
    if f'/{relative}/' not in lines:
        backup.mkdir(parents=True, exist_ok=True)
        lines += ['# the file store: the attachments themselves stay out of git', f'/{relative}/']
        ignore.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
    try:
        check = subprocess.run(['git', '-C', str(backup), 'check-ignore', '-q', f'{relative}/any-file.pdf'], capture_output=True)
    except FileNotFoundError:
        return  # no git on this computer, so nothing can be committed
    # 0: ignored. 128: not a git repo, so nothing to commit to. 1: git would commit the files
    if check.returncode == 1:
        raise ValueError(f"git doesn't ignore the file store {store}: check {ignore}")


def merge(a, b):
    """One index entry from the two sides' entries for the same file or link."""
    merged = {**b, **a}
    for key in ('names', 'sources', 'seen_on'):
        if key in a or key in b:
            merged[key] = sorted(set(a.get(key, [])) | set(b.get(key, [])))
    places = {json.dumps(p, sort_keys=True): p for p in a.get('used_in', []) + b.get('used_in', [])}
    merged['used_in'] = sorted(places.values(), key=lambda p: (p['board'], p['board_id'], p['list'], p['card']))
    dates = [d for d in (a.get('first_uploaded'), b.get('first_uploaded')) if d]
    if dates:
        merged['first_uploaded'] = min(dates)
    return merged


def split(entry, included: set):
    """(the entry as the included side keeps it, as the excluded side keeps it); None for a side
    it doesn't belong to. Each side only names its own boards."""
    boards = file_boards(entry)
    inside, outside = boards & included, boards - included

    def side(mine):
        kept = {**entry, 'used_in': [p for p in entry.get('used_in', []) if p['board_id'] in mine]}
        if 'seen_on' in entry:
            kept['seen_on'] = sorted(mine)
        return kept

    # A file whose boards aren't known is excluded
    return side(inside) if inside else None, side(outside) if outside or not boards else None


def move_boards(source: Path, target: Path, belongs) -> int:
    """Moves each board file in source whose board id passes belongs() into target. Board files
    sit directly in boards/; a workspace folder left empty by older backups is removed."""
    moved = 0
    for path in sorted(source.rglob('*.md')) if source.exists() else []:
        board_id = path.stem.rsplit('[', 1)[-1].rstrip(']')
        if not belongs(board_id):
            continue
        for older in target.rglob(f'*[[]{board_id}].md'):
            older.unlink()
        target.mkdir(parents=True, exist_ok=True)
        path.replace(target / path.name)
        if path.parent != source and not any(path.parent.iterdir()):
            path.parent.rmdir()
        moved += 1
    return moved


def apply_choices(choices, backup_dir: Path, store_dir: Path, excluded_dir: Path):
    """Puts every board and file on its side. Returns what changed, for the run's summary."""
    check_folders(backup_dir, store_dir, excluded_dir)
    included = set(choices['in'])
    excluded_dir.mkdir(parents=True, exist_ok=True)
    if not (excluded_dir / 'README.txt').exists():
        (excluded_dir / 'README.txt').write_text(EXCLUDED_README, encoding='utf-8')

    boards_out = move_boards(backup_dir / 'boards', excluded_dir / 'boards', lambda board_id: board_id not in included)
    boards_back = move_boards(excluded_dir / 'boards', backup_dir / 'boards', lambda board_id: board_id in included)

    inside = FileStore(store_dir, backup_dir / 'attachments.json')
    outside = FileStore(excluded_dir / 'files', excluded_dir / 'attachments.json')
    for kind in ('files', 'links'):
        merged = dict(getattr(outside, kind))
        for key, entry in getattr(inside, kind).items():
            merged[key] = merge(entry, merged[key]) if key in merged else entry
        parts = {key: split(entry, included) for key, entry in merged.items()}
        setattr(inside, kind, {key: sides[0] for key, sides in parts.items() if sides[0]})
        setattr(outside, kind, {key: sides[1] for key, sides in parts.items() if sides[1]})

    # Copy each file to every side that keeps it, save both indexes, and only then remove the
    # copies a side no longer keeps (each one is checked to be safe on the other side first)
    sides = ((inside, outside), (outside, inside))
    for store, other in sides:
        store.store_dir.mkdir(parents=True, exist_ok=True)
        for entry in store.files.values():
            path, elsewhere = store.store_dir / entry['stored_as'], other.store_dir / entry['stored_as']
            if not path.exists() and elsewhere.exists():
                shutil.copy2(elsewhere, path)
    inside.save()
    outside.save()
    removed = {'in': 0, 'out': 0}
    for (store, other), side in zip(sides, ('in', 'out')):
        kept = {entry['stored_as'] for entry in store.files.values()}
        for entry in other.files.values():
            path, safe = store.store_dir / entry['stored_as'], other.store_dir / entry['stored_as']
            if entry['stored_as'] not in kept and path.exists() and safe.exists() and safe.stat().st_size == path.stat().st_size:
                path.unlink()
                removed[side] += 1
    return {'boards_out': boards_out, 'boards_back': boards_back, 'files_in': len(inside.files), 'files_out': len(outside.files),
            'moved_out': removed['in'], 'moved_back': removed['out']}
