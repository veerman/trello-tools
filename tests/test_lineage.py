"""Run: python tests/test_lineage.py

Checks the board lineage: reading board files, suggested lines, the saved lineage, the history
files and their git commits, and the local lineage page's server.
No network and no Trello account needed (the history test needs git).
"""
import json
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'board-backup'))

import lineage as lin  # noqa: E402


def board_file(boards_dir: Path, board_id: str, name: str, created: str, cards=('Kickoff', 'Research')):
    """A board file as backup.py writes it."""
    body = ''.join(f"### {card} [green]\n\nNotes for {card}.\n\n" for card in cards)
    text = (f"---\ntrello_board: {board_id}\nurl: https://trello.com/b/{board_id[:8]}\nworkspace: \"Sample Workspace\"\n"
            f"created: {created}\nlast_activity: 2026-01-03\n---\n\n# {name}\n\n## Week 1\n\n{body}")
    path = boards_dir / f"{name} [{board_id[-8:]}].md"
    path.write_text(text, encoding='utf-8', newline='\n')
    return path


def backup_folder(tmp: str) -> Path:
    backup_dir = Path(tmp)
    boards = backup_dir / 'boards'
    boards.mkdir()
    board_file(boards, 'a' * 24, 'W2025 Garden Plan', '2025-01-06')
    board_file(boards, 'b' * 24, 'S2025 Garden Plan', '2025-05-05', cards=('Kickoff', 'Research', 'Pitch'))
    board_file(boards, 'c' * 24, 'S2025 Garden Plan (WIP)', '2025-04-20')
    board_file(boards, 'd' * 24, 'F2025 Garden Budget', '2025-09-02')
    board_file(boards, 'e' * 24, 'Team Notes', '2024-11-11', cards=('Agenda',))
    return backup_dir


def by_id(backup_dir):
    return {b['id']: b for b in lin.list_boards(backup_dir)}


def test_a_board_file_gives_its_details_name_and_cards():
    with tempfile.TemporaryDirectory() as tmp:
        boards = lin.list_boards(backup_folder(tmp))
    assert [b['name'] for b in boards][:2] == ['Team Notes', 'W2025 Garden Plan'], 'oldest first'
    roadmap = boards[1]
    assert roadmap['id'] == 'a' * 24 and roadmap['workspace'] == 'Sample Workspace' and roadmap['created'] == '2025-01-06'
    assert roadmap['titles'] == ['Kickoff', 'Research'] and roadmap['cards'] == 2
    assert roadmap['base_name'] == 'Garden Plan'


def test_versions_of_one_board_are_suggested_as_a_line_with_drafts_as_side_boards():
    with tempfile.TemporaryDirectory() as tmp:
        boards = lin.list_boards(backup_folder(tmp))
    suggestions = lin.suggest_lines(boards, {'lines': []})
    assert len(suggestions) == 1, 'Garden Budget and Team Notes are not versions of Garden Plan'
    line = suggestions[0]
    assert line['name'] == 'Garden Plan'
    assert line['boards'] == [{'id': 'a' * 24}, {'id': 'c' * 24, 'side': True}, {'id': 'b' * 24}]
    # Boards already in a line aren't suggested again
    assert lin.suggest_lines(boards, {'lines': [{'name': 'Plan', 'boards': [{'id': 'a' * 24}]}]}) == [
        {'name': 'Garden Plan', 'boards': [{'id': 'c' * 24, 'side': True}, {'id': 'b' * 24}]}]


def test_renamed_boards_with_mostly_the_same_cards_are_suggested_together():
    cards = [f'Step {n}' for n in range(8)]
    with tempfile.TemporaryDirectory() as tmp:
        boards_dir = Path(tmp) / 'boards'
        boards_dir.mkdir()
        board_file(boards_dir, 'a' * 24, 'Reading List', '2024-01-01', cards=cards)
        board_file(boards_dir, 'b' * 24, 'Book Club', '2025-01-01', cards=cards[:7] + ['New step'])
        board_file(boards_dir, 'c' * 24, 'Unrelated', '2025-02-01', cards=['Other'] * 6)
        suggestions = lin.suggest_lines(lin.list_boards(Path(tmp)), {'lines': []})
    assert [[b['id'] for b in s['boards']] for s in suggestions] == [['a' * 24, 'b' * 24]]


def test_the_saved_lineage_is_checked_and_drops_boards_that_left_the_backup():
    with tempfile.TemporaryDirectory() as tmp:
        backup_dir = backup_folder(tmp)
        known = by_id(backup_dir)
        good = {'lines': [{'name': 'Plan', 'boards': [{'id': 'a' * 24}, {'id': 'b' * 24, 'side': False}]},
                          {'name': 'Budget', 'boards': [{'id': 'd' * 24}], 'started_from': 'b' * 24}]}
        lineage, _ = lin.clean_lineage(good, known)
        assert lineage['lines'][1]['started_from'] == {'id': 'b' * 24, 'name': 'S2025 Garden Plan'}
        assert lineage['lines'][0]['boards'][0] == {'id': 'a' * 24, 'name': 'W2025 Garden Plan'}

        for bad in ({'lines': [{'name': 'A', 'boards': [{'id': 'a' * 24}]}, {'name': 'a', 'boards': []}]},
                    {'lines': [{'name': 'A', 'boards': [{'id': 'a' * 24}]}, {'name': 'B', 'boards': [{'id': 'a' * 24}]}]},
                    {'lines': [{'name': 'A', 'boards': [{'id': 'f' * 24}]}]},
                    {'lines': [{'name': 'A', 'boards': [{'id': 'a' * 24}], 'started_from': 'a' * 24}]}):
            try:
                lin.clean_lineage(bad, known)
                raise AssertionError(f'accepted {bad}')
            except ValueError:
                pass

        lin.save_lineage(backup_dir, {'lines': [{'name': 'Plan', 'boards': [{'id': 'a' * 24}, {'id': 'f' * 24, 'name': 'Gone'}]}]})
        loaded, dropped = lin.load_lineage(backup_dir, known)
        assert dropped == 1 and [b['id'] for b in loaded['lines'][0]['boards']] == ['a' * 24]


def test_history_is_one_commit_per_version_dated_when_each_board_was_made():
    with tempfile.TemporaryDirectory() as tmp:
        backup_dir = backup_folder(tmp)
        run = lambda *args: subprocess.run(['git', '-C', tmp, *args], check=True, capture_output=True, text=True).stdout
        run('init', '-q')
        run('config', 'user.name', 'Test')
        run('config', 'user.email', 'test@example.com')
        run('add', '.')
        run('commit', '-q', '-m', 'Backup')
        (backup_dir / 'unrelated.txt').write_text('not part of the history commits')

        lin.save_lineage(backup_dir, {'lines': [
            {'name': 'Plan', 'boards': [{'id': 'a' * 24}, {'id': 'c' * 24, 'side': True}, {'id': 'b' * 24}]},
            {'name': 'Budget', 'boards': [{'id': 'd' * 24}], 'started_from': {'id': 'b' * 24}}]})
        plan = lin.plan_history(backup_dir)
        assert [(line['name'], [b['name'] for b in steps]) for line, steps in plan] == [
            ('Plan', ['W2025 Garden Plan', 'S2025 Garden Plan']),
            ('Budget', ['S2025 Garden Plan', 'F2025 Garden Budget'])], 'side boards stay out'
        assert lin.make_history(backup_dir, plan) == 4

        log = run('log', '--format=%ad %s', '--date=short', '--', 'history/Plan.md').splitlines()
        assert log == ['2025-05-05 Plan: S2025 Garden Plan', '2025-01-06 Plan: W2025 Garden Plan']
        newest = (backup_dir / 'boards').glob('S2025 Garden Plan [*.md')
        assert (backup_dir / 'history' / 'Plan.md').read_bytes() == next(newest).read_bytes()
        assert '?? unrelated.txt' in run('status', '--porcelain'), 'only history files are committed'
        assert lin.plan_history(backup_dir) == [], 'a line with a history file is not built again'

        # A backup run after the next term's board joins the line moves the file to it
        board_file(backup_dir / 'boards', 'f' * 24, 'F2025 Garden Plan', '2025-09-01')
        lineage = json.loads((backup_dir / 'lineage.json').read_text(encoding='utf-8'))
        lineage['lines'][0]['boards'].append({'id': 'f' * 24})
        lin.save_lineage(backup_dir, lineage)
        lineage['lines'].append({'name': 'Notes', 'boards': [{'id': 'e' * 24}]})
        lin.save_lineage(backup_dir, lineage)
        assert lin.update_history(backup_dir) == (['Plan'], ['Notes'])
        assert 'F2025 Garden Plan' in (backup_dir / 'history' / 'Plan.md').read_text(encoding='utf-8')
        assert lin.update_history(backup_dir) == ([], ['Notes']), 'nothing changes the second time'


def test_the_page_serves_boards_and_saves_the_lineage():
    with tempfile.TemporaryDirectory() as tmp:
        backup_dir = backup_folder(tmp)
        server, url = lin.make_server(backup_dir, b'<html>lineage page</html>')
        import threading
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            get = lambda path: urllib.request.urlopen(url + path).read()
            assert get('') == b'<html>lineage page</html>'
            data = json.loads(get('data'))
            assert len(data['boards']) == 5 and 'titles' not in data['boards'][0] and len(data['suggestions']) == 1
            assert get(f"board/{'a' * 24}").startswith(b'---\ntrello_board: ' + b'a' * 24)
            assert b'class CompareView' in get('shared/compare-view.js')

            def post(body, content_type='application/json'):
                request = urllib.request.Request(url + 'lineage', data=json.dumps(body).encode(), headers={'Content-Type': content_type})
                return json.loads(urllib.request.urlopen(request).read())

            saved = post({'lines': [{'name': 'Plan', 'boards': [{'id': 'a' * 24}, {'id': 'b' * 24}]}]})
            assert saved['lineage']['lines'][0]['name'] == 'Plan'
            assert saved['suggestions'] == [], 'the rest of Garden Plan is only a draft now'
            assert json.loads((backup_dir / 'lineage.json').read_text(encoding='utf-8')) == saved['lineage']

            for path, body, content_type in (('lineage', {'lines': [{'name': 'X', 'boards': [{'id': 'f' * 24}]}]}, 'application/json'),
                                             ('lineage', {'lines': []}, 'text/plain')):
                try:
                    post(body, content_type)
                    raise AssertionError('accepted')
                except urllib.error.HTTPError as e:
                    assert e.code in (400, 404)
            for path in ('shared/../lineage.py', 'board/nothing', '../data'):
                try:
                    get(path)
                    raise AssertionError(f'served {path}')
                except urllib.error.HTTPError as e:
                    assert e.code == 404
            try:
                urllib.request.urlopen(url.rsplit('/', 2)[0] + '/wrong-key/data')
                raise AssertionError('served without the key')
            except urllib.error.HTTPError as e:
                assert e.code == 404
        finally:
            server.shutdown()
            server.server_close()


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
