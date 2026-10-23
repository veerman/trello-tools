"""Run: python tests/test_choices.py

Checks that included and excluded boards, and their files, are kept apart: what moves where when
a choice changes, that each side only names its own boards, and that the folders must be
separate. No network needed.
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'board-backup'))

import board_choices as bc  # noqa: E402

IN, OUT = 'a' * 24, 'b' * 24


def place(board_id, board):
    return {'board': board, 'board_id': board_id, 'list': 'List', 'card': 'Card'}


def entry(stored_as, boards, seen_on=None):
    return {'sha256': stored_as, 'stored_as': stored_as, 'size': 4, 'type': '', 'names': [stored_as], 'first_uploaded': None,
            'sources': [], 'used_in': [place(b, name) for b, name in boards], 'seen_on': seen_on if seen_on is not None else [b for b, _ in boards]}


def make_backup(tmp: Path):
    backup, store, excluded = tmp / 'backup', tmp / 'files', tmp / 'excluded'
    (backup / 'boards').mkdir(parents=True)
    (backup / 'boards' / f'Roadmap [{IN}].md').write_text('# Roadmap\n')
    (backup / 'boards' / f'Personal notes [{OUT}].md').write_text('# Personal notes\n')
    store.mkdir()
    for name in ('in.pdf', 'out.pdf', 'both.pdf', 'old-in.pdf', 'unknown.pdf'):
        (store / name).write_bytes(b'data')
    files = {
        'in': entry('in.pdf', [(IN, 'Roadmap')]),
        'out': entry('out.pdf', [(OUT, 'Personal notes')]),
        'both': entry('both.pdf', [(IN, 'Roadmap'), (OUT, 'Personal notes')]),
        'old-in': entry('old-in.pdf', [], seen_on=[IN]),
        'unknown': entry('unknown.pdf', [], seen_on=[]),
    }
    links = {'https://docs.google.com/x': {'names': ['Doc'], 'used_in': [place(OUT, 'Personal notes')]}}
    (backup / 'attachments.json').write_text(json.dumps({'files': files, 'links': links}))
    return backup, store, excluded


def names(folder: Path):
    return sorted(p.name for p in folder.rglob('*') if p.is_file())


def test_excluded_boards_and_their_files_move_out_and_nothing_crosses_over():
    with tempfile.TemporaryDirectory() as tmp:
        backup, store, excluded = make_backup(Path(tmp))
        moved = bc.apply_choices({'in': {IN: 'Roadmap'}, 'out': []}, backup, store, excluded)
        assert moved['boards_out'] == 1 and moved['moved_out'] == 2

        assert names(backup / 'boards') == [f'Roadmap [{IN}].md']
        assert names(excluded / 'boards') == [f'Personal notes [{OUT}].md']
        assert (excluded / 'boards' / f'Personal notes [{OUT}].md').exists(), 'board files sit directly in boards/'
        # A file on both sides is in both stores; an old version stays with its board; unknown is excluded
        assert names(store) == ['both.pdf', 'in.pdf', 'old-in.pdf']
        assert names(excluded / 'files') == ['both.pdf', 'out.pdf', 'unknown.pdf']

        inside = (backup / 'attachments.json').read_text()
        assert 'Personal notes' not in inside and OUT not in inside and 'docs.google.com' not in inside
        outside = json.loads((excluded / 'attachments.json').read_text())
        assert sorted(outside['files']) == ['both', 'out', 'unknown'] and list(outside['links']) == ['https://docs.google.com/x']
        assert outside['files']['both']['used_in'] == [place(OUT, 'Personal notes')] and outside['files']['both']['seen_on'] == [OUT]
        assert (excluded / 'README.txt').exists()


def test_running_again_changes_nothing():
    with tempfile.TemporaryDirectory() as tmp:
        backup, store, excluded = make_backup(Path(tmp))
        choices = {'in': {IN: 'Roadmap'}, 'out': []}
        bc.apply_choices(choices, backup, store, excluded)
        before = {p: p.read_bytes() for p in Path(tmp).rglob('*') if p.is_file()}
        moved = bc.apply_choices(choices, backup, store, excluded)
        assert moved['boards_out'] == moved['boards_back'] == moved['moved_out'] == moved['moved_back'] == 0
        assert {p: p.read_bytes() for p in Path(tmp).rglob('*') if p.is_file()} == before


def test_a_board_marked_in_later_comes_back_with_its_files():
    with tempfile.TemporaryDirectory() as tmp:
        backup, store, excluded = make_backup(Path(tmp))
        bc.apply_choices({'in': {IN: 'Roadmap'}, 'out': []}, backup, store, excluded)
        moved = bc.apply_choices({'in': {IN: 'Roadmap', OUT: 'Personal notes'}, 'out': []}, backup, store, excluded)
        assert moved['boards_back'] == 1
        assert names(backup / 'boards') == sorted([f'Roadmap [{IN}].md', f'Personal notes [{OUT}].md'])
        assert names(store) == ['both.pdf', 'in.pdf', 'old-in.pdf', 'out.pdf']
        # Only the file whose boards aren't known is still excluded
        assert names(excluded / 'files') == ['unknown.pdf']
        inside = json.loads((backup / 'attachments.json').read_text())
        assert inside['files']['both']['used_in'] == [place(OUT, 'Personal notes'), place(IN, 'Roadmap')]
        assert inside['files']['both']['seen_on'] == sorted([IN, OUT])


def test_an_included_board_marked_out_later_leaves_with_its_files():
    with tempfile.TemporaryDirectory() as tmp:
        backup, store, excluded = make_backup(Path(tmp))
        bc.apply_choices({'in': {IN: 'Roadmap'}, 'out': []}, backup, store, excluded)
        bc.apply_choices({'in': {}, 'out': [IN]}, backup, store, excluded)
        assert names(backup / 'boards') == [] and names(store) == []
        assert names(excluded / 'files') == ['both.pdf', 'in.pdf', 'old-in.pdf', 'out.pdf', 'unknown.pdf']
        assert json.loads((backup / 'attachments.json').read_text()) == {'files': {}, 'links': {}}


def test_the_folders_must_be_separate():
    with tempfile.TemporaryDirectory() as tmp:
        backup, store, _ = make_backup(Path(tmp))
        for excluded in (backup / 'excluded', store / 'excluded', backup):
            try:
                bc.apply_choices({'in': {}, 'out': []}, backup, store, excluded)
                assert False, f'{excluded} must be refused'
            except ValueError:
                pass
        assert names(backup / 'boards') == sorted([f'Roadmap [{IN}].md', f'Personal notes [{OUT}].md'])


def test_a_file_store_inside_the_backup_folder_is_kept_out_of_git():
    if not shutil.which('git'):
        print("     (skipped: git is not installed)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        backup, _, excluded = make_backup(Path(tmp))
        store = backup / 'files'
        shutil.move(str(Path(tmp) / 'files'), str(store))
        subprocess.run(['git', 'init', '-q', str(backup)], check=True)
        bc.apply_choices({'in': {IN: 'Roadmap'}, 'out': []}, backup, store, excluded)
        assert '/files/' in (backup / '.gitignore').read_text().splitlines()
        untracked = subprocess.run(['git', '-C', str(backup), 'status', '--porcelain', '-uall'], capture_output=True, text=True).stdout
        assert 'files/' not in untracked and 'attachments.json' in untracked, untracked
        assert names(store) == ['both.pdf', 'in.pdf', 'old-in.pdf']

        # If git would commit the files anyway, nothing runs
        (backup / '.gitignore').write_text('/files/\n!/files/\n')
        try:
            bc.check_folders(backup, store, excluded)
            assert False, 'a file store git would commit must be refused'
        except ValueError as e:
            assert "doesn't ignore" in str(e)


if __name__ == '__main__':
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith('test_')]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {name} {e}")
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)
