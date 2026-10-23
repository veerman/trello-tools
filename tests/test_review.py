"""Run: python tests/test_review.py

Checks the board review: what it shows and flags for a board, the saved choices, that backup.py
and upload_to_drive.py keep only In boards, and the local review page's server.
No network and no Trello account needed.
"""
import json
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'board-backup'))

import board_choices as bc  # noqa: E402
import review_boards as review  # noqa: E402
import upload_to_drive as up  # noqa: E402

ME, ALEX = 'a' * 24, 'b' * 24


def trello_board(board_id='65a1b2c3d4e5f6a7b8c9d0e1', name='Notes', members=(ME,), private=True, files=()):
    people = {ME: 'Sam Me', ALEX: 'Alex Other'}
    return {
        'id': board_id, 'name': name, 'shortUrl': 'https://trello.com/b/abc', 'dateLastActivity': '2026-09-01T12:00:00Z',
        'idMemberCreator': members[0], 'prefs': {'permissionLevel': 'private' if private else 'org'},
        'members': [{'id': m, 'fullName': people[m]} for m in members],
        'memberships': [{'idMember': m, 'memberType': 'admin' if m == members[0] else 'normal'} for m in members],
        'lists': [{'name': 'To do'}],
        'cards': [{'name': 'Card', 'attachments': [{'name': f, 'bytes': 10, 'date': '2025-01-02T00:00:00Z', 'isUpload': True} for f in files]
                   + [{'name': 'Shared doc', 'isUpload': False}]}],
    }


def test_a_board_that_may_be_personal_is_flagged():
    board = review.board_summary(trello_board(files=['RE: travel.msg', 'Expense report signed.pdf', 'Deck.pptx']), ME)
    assert board['flags'] == ['Only 1 member', 'Private board', '1 email attachment', '1 personal-looking file']
    assert board['your_role'] == 'admin' and board['made_by'] == 'Sam Me'
    assert board['created'] == '2024-01-12' and board['last_activity'] == '2026-09-01'
    assert [(f['name'], f['hint']) for f in board['files']] == [
        ('Deck.pptx', None), ('Expense report signed.pdf', 'personal'), ('RE: travel.msg', 'email')]
    assert board['links'] == 1 and not board['roadmap']


def test_a_shared_roadmap_has_no_flags():
    board = review.board_summary(trello_board(name='F2026 Phase 1 Roadmap', members=(ALEX, ME), private=False, files=['Deck.pptx']), ME)
    assert board['flags'] == [] and board['roadmap']
    assert board['your_role'] == 'normal' and board['made_by'] == 'Alex Other'
    assert [m['name'] for m in board['members']] == ['Alex Other', 'Sam Me']


def test_choices_are_saved_with_out_boards_by_id_only():
    with tempfile.TemporaryDirectory() as tmp:
        backup_dir = Path(tmp)
        assert bc.load_choices(backup_dir) is None
        choices = {'in': {}, 'out': []}
        bc.set_choice(choices, 'id-1', 'Roadmap', 'in')
        bc.set_choice(choices, 'id-2', 'Someone personal', 'out')
        bc.set_choice(choices, 'id-3', 'Undecided', 'in')
        bc.set_choice(choices, 'id-3', 'Undecided', None)
        bc.save_choices(backup_dir, choices)
        text = (backup_dir / bc.CHOICES_FILE).read_text(encoding='utf-8')
        assert 'Someone personal' not in text and 'Undecided' not in text
        assert bc.load_choices(backup_dir) == {'in': {'id-1': 'Roadmap'}, 'out': ['id-2']}


def test_roadmaps_start_as_in_but_a_choice_is_never_overridden():
    boards = [{'id': '1', 'name': 'W2026 Phase 1', 'roadmap': True}, {'id': '2', 'name': 'Old roadmap', 'roadmap': True},
              {'id': '3', 'name': 'Notes', 'roadmap': False}]
    choices = {'in': {}, 'out': ['2']}
    assert review.start_roadmaps_as_in(boards, choices) == 1
    assert choices == {'in': {'1': 'W2026 Phase 1'}, 'out': ['2']}


def test_only_in_boards_are_backed_up_and_uploaded():
    boards = [('Team', {'id': '1'}), ('Team', {'id': '2'}), ('Team', {'id': '3'})]
    assert bc.keep_chosen(boards, None) == (boards, 0, 0)
    assert bc.keep_chosen(boards, {'in': {'1': 'A'}, 'out': ['2']}) == ([('Team', {'id': '1'})], 1, 1)

    files = {'f1': {'used_in': [{'board_id': '1'}, {'board_id': '2'}]}, 'f2': {'used_in': [{'board_id': '2'}]}, 'f3': {'used_in': []},
             'old': {'used_in': [], 'seen_on': ['1']}}
    assert up.files_on_chosen_boards(files, None) == files
    assert list(up.files_on_chosen_boards(files, {'in': {'1': 'A'}, 'out': ['2']})) == ['f1', 'old']


def test_the_review_page_is_served_under_its_key_and_saves_each_click():
    with tempfile.TemporaryDirectory() as tmp:
        backup_dir = Path(tmp)
        boards = [review.board_summary(trello_board(), ME)]
        choices = {'in': {}, 'out': []}
        server, url = review.make_server(boards, choices, backup_dir, b'<html>page</html>')
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            def call(path, body=None, content_type='application/json'):
                data = json.dumps(body).encode() if body is not None else None
                request = urllib.request.Request(url + path, data=data, headers={'Content-Type': content_type} if data else {})
                try:
                    with urllib.request.urlopen(request) as response:
                        return response.status, response.read()
                except urllib.error.HTTPError as e:
                    return e.code, b''

            assert call('') == (200, b'<html>page</html>')
            assert call('boards')[0] == 200 and json.loads(call('boards')[1])[0]['choice'] is None
            wrong_key = url.rsplit('/', 2)[0] + '/wrong/'
            try:
                urllib.request.urlopen(wrong_key + 'boards')
                assert False, 'a wrong key must not list the boards'
            except urllib.error.HTTPError as e:
                assert e.code == 404

            assert call('choice', {'id': boards[0]['id'], 'choice': 'out'})[0] == 200
            assert bc.load_choices(backup_dir) == {'in': {}, 'out': [boards[0]['id']]}
            assert json.loads(call('boards')[1])[0]['choice'] == 'out'
            assert call('choice', {'id': 'not-a-board', 'choice': 'in'})[0] == 400
            assert call('choice', {'id': boards[0]['id'], 'choice': 'maybe'})[0] == 400
            assert call('choice', {'id': boards[0]['id'], 'choice': 'in'}, content_type='text/plain')[0] == 404
            assert bc.load_choices(backup_dir)['out'] == [boards[0]['id']]
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
