"""Run: python tests/test_drive_upload.py

Checks upload_to_drive.py: the safety checks, the Drive file names, and (when rclone is
installed) a real rclone copy into a local folder standing in for the Drive folder.
"""
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'board-backup'))

import upload_to_drive as up  # noqa: E402


def test_only_a_drive_connection_limited_to_its_own_files_is_accepted():
    assert up.remote_problem('[team]\ntype = drive\nscope = drive.file\ntoken = {"x": 1}\n') is None
    assert 'whole Drive' in up.remote_problem('[team]\ntype = drive\nscope = drive\n')
    assert 'whole Drive' in up.remote_problem('[team]\ntype = drive\n')
    assert "isn't a Google Drive" in up.remote_problem('[team]\ntype = local\n')
    assert 'never finished signing in' in up.remote_problem('[team]\ntype = drive\nscope = drive.file\nclient_id = \n')


def test_signing_in_asks_only_for_its_own_files_and_prints_the_link():
    command = up.sign_in_command('rclone')
    assert command[1:3] == ['authorize', 'drive'] and '--auth-no-open-browser' in command
    settings = json.loads(base64.urlsafe_b64decode(command[3] + '=' * (-len(command[3]) % 4)))
    assert settings == {'scope': 'drive.file'}
    printed = 'Paste the following into your remote machine --->\neyJ0b2tlbiI6Int9In0\n<---End paste\n'
    assert up.signed_in_result(printed) == 'eyJ0b2tlbiI6Int9In0'
    assert up.signed_in_result('Error: something went wrong\n') is None


def test_a_signed_in_connection_is_saved_safely_without_printing_the_token():
    rclone = up.find_rclone()
    if not rclone:
        print("     (skipped: rclone is not installed)")
        return
    token = json.dumps({'access_token': 'fake', 'token_type': 'Bearer', 'refresh_token': 'fake', 'expiry': '2030-01-01T00:00:00Z'})
    result = base64.urlsafe_b64encode(json.dumps({'token': token}).encode()).decode().rstrip('=')
    with tempfile.TemporaryDirectory() as tmp:
        # A throwaway rclone settings file: the real one is never touched
        env = {**os.environ, 'RCLONE_CONFIG': str(Path(tmp) / 'rclone.conf')}
        created = subprocess.run(up.create_command(rclone, 'team', result), capture_output=True, text=True, env=env)
        assert created.returncode == 0 and 'fake' not in created.stdout + created.stderr
        shown = subprocess.run([rclone, 'config', 'show', 'team'], capture_output=True, text=True, env=env).stdout
        assert up.remote_problem(shown) is None


def test_drive_names_are_readable_and_carry_the_fingerprint():
    entry = {'stored_as': '3f2a9c1b7d4e5a60.pdf', 'names': ['Project Plan (Draft) copy.pdf', 'Project Plan (Draft).pdf']}
    assert up.drive_name('3f2a9c1b7d4e5a60', entry) == 'Project Plan (Draft) [3f2a9c1b7d4e5a60].pdf'
    assert up.drive_name('abc', {'stored_as': 'abc.docx', 'names': ['Plan: v2/final?']}) == 'Plan v2final [abc].docx'
    assert up.drive_name('abc', {'stored_as': 'abc.pdf', 'names': []}) == 'abc.pdf'
    assert up.drive_name('abc', {'stored_as': 'abc', 'names': ['README']}) == 'README [abc]'


def test_a_drive_name_is_chosen_once_and_kept():
    files = {'abc': {'stored_as': 'abc.pdf', 'names': ['Long original name.pdf']}}
    assert up.assign_drive_names(files) == 1
    files['abc']['names'].append('Short.pdf')
    assert up.assign_drive_names(files) == 0
    assert files['abc']['drive_name'] == 'Long original name [abc].pdf'


def test_only_copy_is_ever_run():
    command = up.copy_command('rclone', 'view', 'team:Folder', upload=True)
    assert command[1] == 'copy' and '--immutable' in command
    assert not {'sync', 'move', 'delete', 'purge', 'deletefile', 'rmdir'} & set(command)
    assert up.copy_command('rclone', 'view', 'team:Folder', upload=False)[-1] == '--dry-run'


def test_a_real_copy_only_adds_and_never_overwrites_or_deletes():
    rclone = up.find_rclone()
    if not rclone:
        print("     (skipped: rclone is not installed)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        store, dest, view = Path(tmp) / 'store', Path(tmp) / 'drive folder', Path(tmp) / 'view'
        store.mkdir(); dest.mkdir()
        (store / 'aaaa.pdf').write_bytes(b'deck')
        (store / 'bbbb.docx').write_bytes(b'plan')
        (dest / "Someone else's notes.txt").write_text('not ours')
        files = {'aaaa': {'stored_as': 'aaaa.pdf', 'names': ['Deck.pdf']}, 'bbbb': {'stored_as': 'bbbb.docx', 'names': ['Plan.docx']}}
        up.assign_drive_names(files)

        def run(upload):
            if view.exists():
                for f in view.iterdir():
                    f.unlink()
                view.rmdir()
            view.mkdir()
            up.build_upload_view(store, files, view)
            return subprocess.run(up.copy_command(rclone, view, str(dest), upload), capture_output=True, text=True).returncode

        assert run(upload=False) == 0
        assert sorted(p.name for p in dest.iterdir()) == ["Someone else's notes.txt"], 'a dry run uploads nothing'

        assert run(upload=True) == 0
        assert sorted(p.name for p in dest.iterdir()) == ["Deck [aaaa].pdf", "Plan [bbbb].docx", "Someone else's notes.txt"]
        listed = up.list_destination(rclone, str(dest))
        assert {name: item['size'] for name, item in listed.items()} == {"Deck [aaaa].pdf": 4, "Plan [bbbb].docx": 4, "Someone else's notes.txt": 8}
        assert listed["Deck [aaaa].pdf"]['md5'] == hashlib.md5(b'deck').hexdigest()

        # A file in the folder with the same name but different contents is refused, never overwritten
        (dest / "Deck [aaaa].pdf").write_bytes(b'someone edited this')
        assert run(upload=True) != 0
        assert (dest / "Deck [aaaa].pdf").read_bytes() == b'someone edited this'
        assert (dest / "Someone else's notes.txt").read_text() == 'not ours'


def test_a_file_also_on_an_in_board_is_never_removed():
    wanted = {'a': {'drive_name': 'Deck [a].pdf'}}
    others = [{'drive_name': 'Deck [a].pdf'}, {'drive_name': 'Notes [b].pdf'}, {'stored_as': 'never uploaded'}]
    assert up.names_to_remove(wanted, others) == {'Notes [b].pdf'}
    command = up.remove_command('rclone', 'team:Folder', 'list.txt', 1, confirm=False)
    assert command[1] == 'delete' and command[-1] == '--dry-run'
    assert {'--files-from-raw', '--max-delete', '--drive-use-trash=false'} <= set(command)
    assert not {'purge', 'rmdir', 'rmdirs', '--rmdirs', 'sync'} & set(command)
    assert up.remove_command('rclone', 'team:Folder', 'list.txt', 1, confirm=True)[-1] != '--dry-run'
    assert up.link_command('rclone', 'team:Folder', 'Deck [a].pdf') == ['rclone', 'link', 'team:Folder/Deck [a].pdf']
    assert up.touch_command('rclone', 'team:Folder', 'Deck [a].pdf', 1704276000) == [
        'rclone', 'touch', 'team:Folder/Deck [a].pdf', '--no-create', '--timestamp', '2024-01-03T10:00:00']


def test_a_real_removal_deletes_only_the_listed_files_and_dates_change_only_dates():
    rclone = up.find_rclone()
    if not rclone:
        print("     (skipped: rclone is not installed)")
        return
    with tempfile.TemporaryDirectory() as tmp:
        dest, store = Path(tmp) / 'drive folder', Path(tmp) / 'store'
        dest.mkdir(); store.mkdir()
        for name in ('Notes [b].pdf', '#odd [c].pdf', 'Deck [a].pdf', "Someone else's notes.txt"):
            (dest / name).write_bytes(b'data')
        listing = Path(tmp) / 'remove.txt'
        listing.write_text('Notes [b].pdf\n#odd [c].pdf\n', encoding='utf-8', newline='\n')

        assert subprocess.run(up.remove_command(rclone, str(dest), listing, 2, confirm=False), capture_output=True).returncode == 0
        assert len(list(dest.iterdir())) == 4, 'a dry run deletes nothing'
        assert subprocess.run(up.remove_command(rclone, str(dest), listing, 2, confirm=True), capture_output=True).returncode == 0
        assert sorted(p.name for p in dest.iterdir()) == ["Deck [a].pdf", "Someone else's notes.txt"]

        # The date moves to the laptop copy's date only when the bytes match
        (store / 'a.pdf').write_bytes(b'data')
        os.utime(store / 'a.pdf', (1704276000, 1704276000))
        (store / 'z.pdf').write_bytes(b'other')
        os.utime(store / 'z.pdf', (1704276000, 1704276000))
        (dest / 'Zed [z].pdf').write_bytes(b'edited')
        wanted = {'a': {'drive_name': 'Deck [a].pdf', 'stored_as': 'a.pdf'}, 'z': {'drive_name': 'Zed [z].pdf', 'stored_as': 'z.pdf'}}
        dates = up.dates_to_set(store, wanted, up.list_destination(rclone, str(dest)))
        assert dates == [('Deck [a].pdf', 1704276000)]
        assert subprocess.run(up.touch_command(rclone, str(dest), *dates[0]), capture_output=True).returncode == 0
        assert abs((dest / 'Deck [a].pdf').stat().st_mtime - 1704276000) <= 1 and (dest / 'Deck [a].pdf').read_bytes() == b'data'
        assert subprocess.run(up.touch_command(rclone, str(dest), 'Missing.pdf', 1704276000), capture_output=True).returncode == 0
        assert not (dest / 'Missing.pdf').exists(), '--no-create never makes a file'


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
