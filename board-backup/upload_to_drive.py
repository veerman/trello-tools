"""Copies the included files into one Google Drive folder with rclone.

    python upload_to_drive.py --connect             connect rclone to the Google account (once; prints a sign-in link)
    python upload_to_drive.py                       dry run: shows what would be uploaded, uploads nothing
    python upload_to_drive.py --upload              uploads new files and sets the dates of ones already there
    python upload_to_drive.py --remove-excluded     dry run: lists files in the folder that aren't on an In board
    python upload_to_drive.py --remove-excluded --confirm   deletes those, permanently
    python upload_to_drive.py --share               dry run: lists files not yet viewable by link
    python upload_to_drive.py --share --confirm     makes each one viewable by anyone with its link

Safety is enforced here, not left to care:
- The connection must use Google's drive.file permission: rclone can then only see files it
  created itself. Nothing else in that Drive is visible to it, so nothing else can be changed
  or deleted.
- Only files on a board marked In are uploaded (see board_choices.py), from the file store only.
- Uploads only ever run `rclone copy --immutable`: it adds files that aren't there yet and
  refuses to change any that are. Nothing is ever synced or moved.
- A file's date is set only when the file in Drive matches the laptop copy byte for byte.
- Files are deleted only with --remove-excluded --confirm, by exact name, and only files that
  aren't on any In board.
- Sharing is per file ("anyone with the link can view"), never the folder, so nobody can list
  what is in it. Each file's link is kept in attachments.json as drive_link.
- Everything happens in the one folder named by DRIVE_FOLDER.

Files are named "<name> [<fingerprint>].<ext>". The name is chosen once (the shortest name the
file has had, usually the original) and kept in attachments.json as drive_name, so a file never
gets a second name and is never uploaded twice.

Settings in .env: DRIVE_REMOTE (the rclone connection's name), DRIVE_FOLDER, plus FILE_STORE and
BACKUP_DIR from backup.py.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from backup import folder_setting, setting, store_folder
from board_choices import check_folders, file_boards, load_choices
from file_store import FileStore


def find_rclone():
    found = shutil.which('rclone')
    if found:
        return found
    # winget's link folder, for a shell opened before rclone was installed
    links = Path(os.environ.get('LOCALAPPDATA', '')) / 'Microsoft' / 'WinGet' / 'Links' / 'rclone.exe'
    return str(links) if links.exists() else None


def config_values(config_text: str):
    """The settings in `rclone config show` output, as a dict."""
    values = dict(line.split('=', 1) for line in config_text.splitlines() if '=' in line)
    return {key.strip(): value.strip() for key, value in values.items()}


def remote_problem(config_text: str):
    """Why a connection's settings (from `rclone config show`) are unsafe, or None if they're fine."""
    values = config_values(config_text)
    if values.get('type') != 'drive':
        return "it isn't a Google Drive connection"
    if values.get('scope') != 'drive.file':
        return "it doesn't use the drive.file permission, so it could see the whole Drive"
    if not values.get('token'):
        return "it never finished signing in (run: python upload_to_drive.py --connect)"
    return None


def sign_in_command(rclone):
    # rclone's "sign in from a machine with a browser" step. It prints the link instead of opening
    # the usual browser, so it can go in a private window: a browser signed in to several Google
    # accounts can get a "400 malformed" error from Google
    settings = base64.urlsafe_b64encode(json.dumps({'scope': 'drive.file'}).encode()).decode().rstrip('=')
    return [rclone, 'authorize', 'drive', settings, '--auth-no-open-browser']


def signed_in_result(output: str):
    """What `rclone authorize` prints between its paste markers once signed in, or None."""
    match = re.search(r'--->\s*(\S+)\s*<---End paste', output)
    return match.group(1) if match else None


def create_command(rclone, remote, result):
    # --no-output: rclone would otherwise print the new connection, sign-in token included
    return [rclone, 'config', 'create', remote, 'drive', 'scope=drive.file', 'config_is_local=false',
            f'config_token={result}', '--no-output']


def drive_name(fingerprint: str, entry) -> str:
    """"<name> [<fingerprint>].<ext>", from the shortest name the file has had."""
    ext = os.path.splitext(entry['stored_as'])[1]
    names = [n for n in entry.get('names', []) if n.strip()]
    base = min(names, key=lambda n: (len(n), n)) if names else ''
    if os.path.splitext(base)[1].lower() == ext.lower():
        base = os.path.splitext(base)[0]
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '', base).strip()[:120].strip()
    return f"{base} [{fingerprint}]{ext}" if base else f"{fingerprint}{ext}"


def assign_drive_names(files) -> int:
    """Gives every file without one its permanent drive_name. Returns how many were new."""
    new = 0
    for fingerprint, entry in files.items():
        if not entry.get('drive_name'):
            entry['drive_name'] = drive_name(fingerprint, entry)
            new += 1
    return new


def files_on_chosen_boards(files, choices):
    """The files on a board marked In with review_boards.py (every file before a review)."""
    if choices is None:
        return files
    return {fp: e for fp, e in files.items() if file_boards(e) & set(choices['in'])}


def names_to_remove(wanted, others):
    """Drive names of files that aren't on an In board. A file also on an In board is never one."""
    keep = {e.get('drive_name') for e in wanted.values()}
    return {e['drive_name'] for e in others if e.get('drive_name') and e['drive_name'] not in keep}


def dates_to_set(store_dir: Path, wanted, existing):
    """[(Drive name, seconds)] for our files in the folder that match the laptop copy byte for
    byte but carry a different date."""
    changes = []
    for entry in wanted.values():
        there, path = existing.get(entry['drive_name']), store_dir / entry['stored_as']
        if not there or not path.exists() or abs(there['modified'] - path.stat().st_mtime) <= 1:
            continue
        if there['size'] == path.stat().st_size and there['md5'] == hashlib.md5(path.read_bytes()).hexdigest():
            changes.append((entry['drive_name'], path.stat().st_mtime))
    return changes


def build_upload_view(store_dir: Path, files, view_dir: Path):
    """A folder of links to the stored files under their Drive names (hard links, so no extra disk)."""
    for entry in files.values():
        source = store_dir / entry['stored_as']
        if not source.exists():
            continue
        target = view_dir / entry['drive_name']
        try:
            os.link(source, target)
        except OSError:
            shutil.copy2(source, target)


def parse_time(text: str) -> float:
    # rclone gives nanoseconds; Python reads at most microseconds
    return datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', text).replace('Z', '+00:00')).timestamp()


def list_destination(rclone, destination):
    """{name: {size, md5, modified}} of the files already in the destination folder (empty if it
    doesn't exist yet)."""
    result = subprocess.run([rclone, 'lsjson', destination, '--files-only', '--hash'], capture_output=True, text=True, encoding='utf-8')
    if result.returncode != 0:
        if 'directory not found' in (result.stderr or '').lower():
            return {}
        raise RuntimeError(f"rclone could not list {destination}: {result.stderr.strip()}")
    return {item['Name']: {'size': item['Size'], 'md5': (item.get('Hashes') or {}).get('md5'), 'modified': parse_time(item['ModTime'])}
            for item in json.loads(result.stdout or '[]')}


def copy_command(rclone, view_dir, destination, upload: bool):
    # copy, never sync: files already in the folder are never changed or deleted
    command = [rclone, 'copy', str(view_dir), destination, '--immutable', '--checksum', '--stats-one-line', '-v']
    return command if upload else command + ['--dry-run']


def touch_command(rclone, destination, name, when: float):
    # Changes only the date of one file that is already there; --no-create never makes a new one
    stamp = datetime.fromtimestamp(when, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')
    return [rclone, 'touch', f"{destination}/{name}", '--no-create', '--timestamp', stamp]


def set_drive_dates(rclone, destination, dates) -> list:
    """Sets each (Drive name, seconds) date. Returns the names that failed."""
    failed = []
    for i, (name, when) in enumerate(dates, 1):
        print(f"\rSetting dates: {i}/{len(dates)}", end='', flush=True)
        if subprocess.run(touch_command(rclone, destination, name, when), capture_output=True).returncode:
            failed.append(name)
    if dates:
        print(f"\nDates set: {len(dates) - len(failed)}." + (f" Failed: {len(failed)}." if failed else ''))
    return failed


def link_command(rclone, destination, name):
    # On Drive, rclone link gives the one file an "anyone with the link can view" permission and
    # prints its link. The folder stays private, so nobody can list what is in it
    return [rclone, 'link', f"{destination}/{name}"]


def save_index(index_path: Path, index):
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')


def remove_command(rclone, destination, list_file, count: int, confirm: bool):
    # Only the files named in the list (read as plain names, not patterns), never folders, never
    # more than count; permanently, so excluded files don't sit in the shared account's trash
    command = [rclone, 'delete', destination, '--files-from-raw', str(list_file), '--max-delete', str(count),
               '--drive-use-trash=false', '-v']
    return command if confirm else command + ['--dry-run']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--connect', action='store_true', help='connect rclone to the Google account (prints a sign-in link)')
    parser.add_argument('--upload', action='store_true', help='upload for real (without it: dry run)')
    parser.add_argument('--remove-excluded', action='store_true', help='list the files in the folder that are not on an In board')
    parser.add_argument('--share', action='store_true', help='list the files not yet viewable by anyone with their link')
    parser.add_argument('--confirm', action='store_true', help='with --remove-excluded: delete them, permanently; with --share: share them')
    args = parser.parse_args(argv)

    rclone = find_rclone()
    if not rclone:
        print("rclone isn't installed. On Windows: winget install Rclone.Rclone")
        return 1
    remote = setting('DRIVE_REMOTE') or 'trello-files'
    folder = setting('DRIVE_FOLDER')

    remotes = subprocess.run([rclone, 'listremotes'], capture_output=True, text=True).stdout.split()
    shown = subprocess.run([rclone, 'config', 'show', remote], capture_output=True, text=True).stdout if f"{remote}:" in remotes else ''
    if args.connect:
        if f"{remote}:" in remotes:
            if config_values(shown).get('token'):
                print(f"A connection named {remote!r} already exists; nothing changed.")
                return 1
            # Only this laptop's rclone settings: an unfinished connection never reached the Drive
            print(f"Removing the unfinished connection {remote!r} from an earlier try, and starting again.")
            subprocess.run([rclone, 'config', 'delete', remote], check=True)
        print("rclone will print a sign-in link (http://127.0.0.1:53682/...). Copy it into a private window")
        print("(Chrome or Edge: Ctrl+Shift+N), sign in to the Google account that should hold the files, and allow access.")
        print("Google will say the app can only use files it creates: that is the safety lock.\n")
        # The link goes to the terminal (stderr); the sign-in result is kept out of it
        signed_in = subprocess.run(sign_in_command(rclone), stdout=subprocess.PIPE, text=True)
        result = signed_in_result(signed_in.stdout or '')
        if signed_in.returncode != 0 or not result:
            print("Signing in didn't finish, so nothing was saved. Run --connect again to retry.")
            return 1
        created = subprocess.run(create_command(rclone, remote, result))
        if created.returncode == 0:
            print(f"\nConnected as {remote!r}. Next, the dry run: python upload_to_drive.py")
        return created.returncode

    if f"{remote}:" not in remotes:
        print(f"No rclone connection named {remote!r} yet. Run: python upload_to_drive.py --connect")
        return 1
    problem = remote_problem(shown)
    if problem:
        print(f"Stopped: the connection {remote!r} is not safe to use, because {problem}.")
        return 1
    if not folder:
        print("Set DRIVE_FOLDER in .env to the folder name to upload into.")
        return 1

    backup_dir = folder_setting('BACKUP_DIR', 'backup')
    index_path = backup_dir / 'attachments.json'
    store_dir = store_folder(backup_dir)
    check_folders(backup_dir, store_dir)
    FileStore(store_dir, index_path).set_dates()
    index = json.loads(index_path.read_text(encoding='utf-8'))
    if assign_drive_names(index['files']):
        save_index(index_path, index)
    wanted = files_on_chosen_boards(index['files'], load_choices(backup_dir))
    excluded_index = folder_setting('EXCLUDED_DIR', 'excluded') / 'attachments.json'
    excluded = json.loads(excluded_index.read_text(encoding='utf-8'))['files'] if excluded_index.exists() else {}
    others = list(excluded.values()) + [e for fp, e in index['files'].items() if fp not in wanted]

    destination = f"{remote}:{folder}"
    existing = list_destination(rclone, destination)
    to_remove = sorted(names_to_remove(wanted, others) & set(existing))
    print(f"Destination: {folder!r} in the {remote!r} connection")

    if args.remove_excluded:
        print(f"Files in the folder that aren't on an In board: {len(to_remove)}")
        for name in to_remove[:10]:
            print(f"  {name}")
        if len(to_remove) > 10:
            print(f"  ... and {len(to_remove) - 10} more")
        if not to_remove:
            return 0
        with tempfile.TemporaryDirectory(dir=store_dir, prefix='.drive-remove-') as tmp:
            list_file = Path(tmp) / 'remove.txt'
            list_file.write_text('\n'.join(to_remove) + '\n', encoding='utf-8', newline='\n')
            result = subprocess.run(remove_command(rclone, destination, list_file, len(to_remove), args.confirm))
        if not args.confirm:
            print("\nDry run only: nothing was deleted. To delete these files permanently (they skip the Drive trash):")
            print("  python upload_to_drive.py --remove-excluded --confirm")
            return result.returncode
        left = set(to_remove) & set(list_destination(rclone, destination))
        print(f"\nRemoved {len(to_remove) - len(left)} files permanently." + (f" {len(left)} could not be removed." if left else ''))
        return result.returncode or (1 if left else 0)

    if args.share:
        to_share = sorted((e for e in wanted.values() if e['drive_name'] in existing and not e.get('drive_link')), key=lambda e: e['drive_name'])
        print(f"Files to make viewable by anyone with their link: {len(to_share)} (the folder stays private)")
        if not to_share:
            return 0
        if not args.confirm:
            print("\nDry run only: nothing was shared. To share them: python upload_to_drive.py --share --confirm")
            return 0
        failed = []
        try:
            for i, entry in enumerate(to_share, 1):
                print(f"\rSharing: {i}/{len(to_share)}", end='', flush=True)
                result = subprocess.run(link_command(rclone, destination, entry['drive_name']), capture_output=True, text=True)
                link = result.stdout.strip()
                if result.returncode == 0 and link.startswith('https://'):
                    entry['drive_link'] = link
                else:
                    failed.append(entry['drive_name'])
        finally:
            # Saved even if stopped part way, so no link is lost
            save_index(index_path, index)
        print(f"\nShared: {len(to_share) - len(failed)}." + (f" Failed: {len(failed)}." if failed else '') + " Links saved as drive_link in attachments.json.")
        # Sharing a file moves its Drive date to now, so its upload date is put back
        dates = dates_to_set(store_dir, wanted, list_destination(rclone, destination))
        unset = set_drive_dates(rclone, destination, dates)
        return 1 if failed or unset else 0

    if to_remove:
        print(f"Warning: {len(to_remove)} files in the folder aren't on an In board. To remove them: python upload_to_drive.py --remove-excluded")
    to_upload = [e for e in wanted.values() if e['drive_name'] not in existing and (store_dir / e['stored_as']).exists()]
    dates = dates_to_set(store_dir, wanted, existing)
    size = sum(e['size'] for e in to_upload)
    print(f"Already there: {len(existing)} files. To upload: {len(to_upload)} files ({size / 1024 / 1024:,.1f} MB). "
          f"Dates to set: {len(dates)}.")
    for entry in sorted(to_upload, key=lambda e: e['drive_name'])[:10]:
        print(f"  {entry['drive_name']}")
    if len(to_upload) > 10:
        print(f"  ... and {len(to_upload) - 10} more")

    returncode = 0
    if to_upload:
        with tempfile.TemporaryDirectory(dir=store_dir, prefix='.drive-upload-') as view:
            new = {e['drive_name'] for e in to_upload}
            build_upload_view(store_dir, {fp: e for fp, e in wanted.items() if e['drive_name'] in new}, Path(view))
            returncode = subprocess.run(copy_command(rclone, view, destination, args.upload)).returncode
    if args.upload and dates:
        returncode = returncode or (1 if set_drive_dates(rclone, destination, dates) else 0)
    if not args.upload and (to_upload or dates):
        print("\nDry run only: nothing was changed. To upload and set the dates, run: python upload_to_drive.py --upload")
    return returncode


if __name__ == '__main__':
    sys.exit(main())
