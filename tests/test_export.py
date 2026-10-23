"""Run: python tests/test_export.py

Checks the backup's Markdown against tests/fixtures. The editor's exporter is checked
against the same fixtures by tests/export.test.js, so the two can't drift.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'board-backup'))

import board_markdown  # noqa: E402

PLAN_URL = 'https://trello.com/1/cards/C5/attachments/A1/download/Plan_v2.docx'


def fixture(name):
    return (FIXTURES / name).read_text(encoding='utf-8').replace('\r\n', '\n')


def test_export_matches_backup_fixture():
    board = json.loads(fixture('board.json'))
    assert board_markdown.board_to_markdown(board, {PLAN_URL: '3f2a9c1b7d4e5a60'}) == fixture('board-backup.md')


def test_backup_fixture_is_editor_fixture_plus_comments_and_fingerprints():
    backup = fixture('board-backup.md')
    without_comments = re.sub(r'###### Comments\n.*?(?=^#{2,3} |\Z)', '', backup, flags=re.S | re.M)
    without_fingerprints = re.sub(r' "sha256:[0-9a-f]+"\)', ')', without_comments)
    assert without_fingerprints == fixture('board.md')


def test_front_matter_dates_come_from_the_id_and_last_activity():
    block = board_markdown.front_matter({'id': '65a1b2c3d4e5f6a7b8c9d0e1', 'dateLastActivity': '2026-01-03T09:00:00.000Z'})
    assert block == '---\ntrello_board: 65a1b2c3d4e5f6a7b8c9d0e1\ncreated: 2024-01-12\nlast_activity: 2026-01-03\n---\n\n'
    assert board_markdown.front_matter({}) == ''


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
