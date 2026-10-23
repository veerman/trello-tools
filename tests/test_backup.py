"""Run: python tests/test_backup.py

Checks the backup's file store, board files, and settings against a local web server.
No network and no Trello account needed.
"""
import http.server
import json
import os
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'board-backup'))

import backup  # noqa: E402
import board_markdown  # noqa: E402
import env  # noqa: E402
import file_store  # noqa: E402
from file_store import FileStore  # noqa: E402


class FakeServer(http.server.BaseHTTPRequestHandler):
    """Paths with "missing" 404; paths with "same" all return one shared file; the rest echo
    their path. Records hits and auth headers."""
    hits = []
    seen_auth = {}

    def do_GET(self):
        FakeServer.hits.append(self.path)
        FakeServer.seen_auth[self.path] = self.headers.get('Authorization')
        if 'missing' in self.path:
            self.send_error(404)
            return
        body = b'the same deck' if 'same' in self.path else f'contents of {self.path}'.encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start_server():
    server = http.server.HTTPServer(('127.0.0.1', 0), FakeServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def sample_board(base, board_id='65a1b2c3d4e5f6a7b8c9d0e1', name='Board A'):
    return {
        'id': board_id, 'name': name,
        'lists': [{'id': 'L1', 'name': 'Week 1', 'pos': 1}],
        'cards': [
            {'id': 'C1', 'idList': 'L1', 'pos': 1, 'name': 'Kickoff', 'attachments': [
                {'name': 'Deck.pptx', 'url': f'{base}/a/same/Deck.pptx', 'date': '2025-02-01T10:00:00Z'},
                {'name': 'Plan.pdf', 'url': f'{base}/trello.com/Plan.pdf'},
                {'name': 'Gone.pdf', 'url': f'{base}/files/missing.pdf'},
                {'name': 'Shared doc', 'url': 'https://docs.google.com/document/d/abc'}]},
            {'id': 'C2', 'idList': 'L1', 'pos': 2, 'name': 'Research', 'attachments': [
                {'name': 'Deck copy.pptx', 'url': f'{base}/b/same/Deck%20copy.pptx', 'date': '2024-09-01T10:00:00Z'}]}
        ]
    }


def record(store, board):
    return store.record_board(board, board_markdown.open_lists_and_cards(board))


def test_each_file_is_stored_once_and_every_place_is_indexed():
    server, base = start_server()
    os.environ['TRELLO_API_KEY'], os.environ['TRELLO_API_TOKEN'] = 'FAKEKEY', 'FAKETOKEN'
    try:
        with tempfile.TemporaryDirectory() as tmp:
            store = FileStore(Path(tmp) / 'files', Path(tmp) / 'backup' / 'attachments.json')
            fingerprints = record(store, sample_board(base))
            store.save()
            index = json.loads((Path(tmp) / 'backup' / 'attachments.json').read_text(encoding='utf-8'))
            stored = sorted(p.name for p in (Path(tmp) / 'files').iterdir())

            # Two links to the same bytes are one stored file with two names, sources, and places
            deck = fingerprints[f'{base}/a/same/Deck.pptx']
            assert deck == fingerprints[f'{base}/b/same/Deck%20copy.pptx']
            assert len(stored) == 2 and f'{deck}.pptx' in stored, stored
            entry = index['files'][deck]
            assert entry['names'] == ['Deck copy.pptx', 'Deck.pptx']
            assert len(entry['sources']) == 2 and entry['first_uploaded'] == '2024-09-01'
            assert [p['card'] for p in entry['used_in']] == ['Kickoff', 'Research']

            # A Google Doc stays a link; a failed download is reported and kept as a marked link
            assert sorted(index['links']) == [f'{base}/files/missing.pdf', 'https://docs.google.com/document/d/abc']
            assert [f['name'] for f in store.failures] == ['Gone.pdf'] and '404' in store.failures[0]['error']
            assert '404' in index['links'][f'{base}/files/missing.pdf']['not_stored']
            assert 'not_stored' not in index['links']['https://docs.google.com/document/d/abc']
            # The fake "trello.com" in the path must not get the token: only real Trello hosts do
            assert not any(FakeServer.seen_auth.values()), FakeServer.seen_auth

            # Another board with the same broken link doesn't try it again in the same run
            hits_before = len(FakeServer.hits)
            record(store, sample_board(base, board_id='6800000000000000000000aa', name='Board B'))
            assert FakeServer.hits[hits_before:] == [] and len(store.failures) == 1
            assert sorted(p['board'] for p in index['links'][f'{base}/files/missing.pdf']['used_in']) == ['Board A']
            store.save()
            index = json.loads((Path(tmp) / 'backup' / 'attachments.json').read_text(encoding='utf-8'))
            assert sorted(p['board'] for p in index['links'][f'{base}/files/missing.pdf']['used_in']) == ['Board A', 'Board B']

            # A second run downloads nothing it already has
            hits_before = len(FakeServer.hits)
            again = FileStore(Path(tmp) / 'files', Path(tmp) / 'backup' / 'attachments.json')
            assert record(again, sample_board(base)) == fingerprints
            new_hits = FakeServer.hits[hits_before:]
            assert new_hits == ['/files/missing.pdf'], new_hits
            assert again.downloaded == 0 and again.reused == 3
    finally:
        server.shutdown()


def test_a_removed_attachment_drops_out_of_the_index():
    server, base = start_server()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            store = FileStore(Path(tmp) / 'files', Path(tmp) / 'attachments.json')
            board = sample_board(base)
            record(store, board)
            board['cards'][0]['attachments'] = board['cards'][0]['attachments'][:1]
            board['cards'][1]['attachments'] = []
            record(store, board)
            store.save()
            index = json.loads((Path(tmp) / 'attachments.json').read_text(encoding='utf-8'))
            used = {fp: [p['card'] for p in entry['used_in']] for fp, entry in index['files'].items()}
            assert sorted(used.values()) == [[], ['Kickoff']], used
            assert index['links'] == {}
            # The board it was on is remembered, so an old version stays with its board
            assert all(entry['seen_on'] == [board['id']] for entry in index['files'].values())
    finally:
        server.shutdown()


def test_each_stored_file_is_dated_when_it_was_first_uploaded_to_trello():
    # An attachment id starts with its creation time: 0x65953ea0 is 2024-01-03 11:01:52 UTC
    trello = 'https://trello.com/1/cards/65953ea0aaaaaaaaaaaaaaaa/attachments/65953ea0bbbbbbbbbbbbbbbb/download/Deck.pptx'
    later = 'https://trello.com/1/cards/67000000aaaaaaaaaaaaaaaa/attachments/67000000bbbbbbbbbbbbbbbb/download/Deck.pptx'
    assert file_store.upload_time(trello) == 0x65953ea0
    assert file_store.upload_time('https://example.com/attachments/65953ea0bbbbbbbbbbbbbbbb/x') is None
    assert file_store.file_date({'sources': [later, trello]}) == 0x65953ea0
    assert file_store.file_date({'sources': ['https://example.com/x.pdf'], 'first_uploaded': '2024-01-03'}) == 1704240000
    assert file_store.file_date({'sources': []}) is None
    with tempfile.TemporaryDirectory() as tmp:
        store = FileStore(Path(tmp) / 'files', Path(tmp) / 'attachments.json')
        fingerprint = store.add_file(b'deck', 'Deck.pptx', later)
        store._note(store.files[fingerprint], 'Deck.pptx', trello, '')
        assert store.set_dates() == 1 and store.set_dates() == 0
        assert store.path_of(fingerprint).stat().st_mtime == 0x65953ea0


def test_same_named_boards_keep_one_order_whatever_order_they_are_backed_up_in():
    def index_after(order):
        with tempfile.TemporaryDirectory() as tmp:
            store = FileStore(Path(tmp) / 'files', Path(tmp) / 'attachments.json')
            for board_id in order:
                board = {'id': board_id, 'name': 'Same Name', 'lists': [{'id': 'L', 'name': 'L', 'pos': 1}],
                         'cards': [{'id': 'C', 'idList': 'L', 'pos': 1, 'name': 'C',
                                    'attachments': [{'name': 'Doc', 'url': 'https://docs.google.com/document/d/x'}]}]}
                record(store, board)
            store.save()
            return (Path(tmp) / 'attachments.json').read_text(encoding='utf-8')
    first, second = '65a1b2c3d4e5f6a7b8c9d0e1', '6800000000000000000000aa'
    assert index_after([first, second]) == index_after([second, first])


def test_markdown_shows_the_fingerprint_of_each_stored_file():
    board = sample_board('https://example.com')
    md = board_markdown.board_to_markdown(board, {'https://example.com/a/same/Deck.pptx': 'abcdef0123456789'})
    assert '- [Deck.pptx](https://example.com/a/same/Deck.pptx "sha256:abcdef0123456789")' in md
    assert '- [Shared doc](https://docs.google.com/document/d/abc)\n' in md


def test_a_renamed_board_replaces_its_old_file():
    with tempfile.TemporaryDirectory() as tmp:
        boards_dir = Path(tmp) / 'boards'
        board = {'id': '65a1b2c3d4e5f6a7b8c9d0e1', 'name': 'Spring Plan'}
        first = backup.write_board_file(boards_dir, board, '# Spring Plan\n')
        board['name'] = 'Fall Plan'
        second = backup.write_board_file(boards_dir, board, '# Fall Plan\n')
        assert not first.exists() and second.exists()
        assert second == boards_dir / 'Fall Plan [65a1b2c3d4e5f6a7b8c9d0e1].md'

        # A file in a workspace folder from an older backup moves up, and the empty folder goes
        older = boards_dir / 'My Workspace' / 'Other Plan [65a1b2c3d4e5f6a7b8c9d0e2].md'
        older.parent.mkdir()
        older.write_text('# Other Plan\n')
        moved = backup.write_board_file(boards_dir, {'id': '65a1b2c3d4e5f6a7b8c9d0e2', 'name': 'Other Plan'}, '# Other Plan\n')
        assert moved == boards_dir / older.name and not older.parent.exists()


def test_token_only_goes_to_trello_hosts():
    assert file_store.is_trello_host('https://trello.com/1/cards/x/attachments/y/download/f.pdf')
    assert file_store.is_trello_host('https://api.trello.com/1/boards/x')
    assert not file_store.is_trello_host('https://trello.com.example.net/f.pdf')
    assert not file_store.is_trello_host('https://example.net/trello.com/f.pdf')


def test_redirects_drop_the_token_when_leaving_trello():
    handler = file_store.StripAuthOnForeignRedirect()

    def follow(new_url):
        req = urllib.request.Request('https://trello.com/1/cards/x/attachments/y/download/f.pdf',
                                     headers={'Authorization': 'OAuth secret'})
        return handler.redirect_request(req, None, 302, 'Found', {}, new_url).get_header('Authorization')

    assert follow('https://files.example.net/f.pdf') is None
    assert follow('https://trello.com/other/f.pdf') == 'OAuth secret'


def test_stored_files_keep_a_sensible_extension():
    assert file_store.extension_for('README', 'https://trello.com/1/cards/c/attachments/a/download/README') == ''
    assert file_store.extension_for('', 'https://example.com/Deck%20v2.PPTX') == '.pptx'
    assert file_store.extension_for('notes.txt', 'https://example.com/x.pdf') == '.txt'


def test_env_file_is_read_without_overriding_the_environment():
    with tempfile.TemporaryDirectory() as tmp:
        env_file = Path(tmp) / '.env'
        env_file.write_text('# settings\nTEST_ENV_A=plain\nTEST_ENV_B="quoted value"\nTEST_ENV_C=from file\n', encoding='utf-8')
        os.environ['TEST_ENV_C'] = 'from environment'
        env.load_env(env_file)
    assert os.environ['TEST_ENV_A'] == 'plain'
    assert os.environ['TEST_ENV_B'] == 'quoted value'
    assert os.environ['TEST_ENV_C'] == 'from environment'


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
