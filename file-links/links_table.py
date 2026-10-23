"""Builds the Links table for the lookup from a backup's attachments.json, as a CSV to import
into the private Sheet: name, link, file, uploaded.

Run: python links_table.py <backup folder>/attachments.json links.csv

Every file shared to Drive (it has a drive_link, see board-backup/upload_to_drive.py --share)
gets a short name from its file name, like "project-plan-draft". When several files
share a short name (versions of one file, or just many files called "image"), the short name
points to the newest, and each file also gets the short name plus its fingerprint, so every file
can be linked on its own. To point a name at a new version later, change its link in the Sheet.
"""
import csv
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'board-backup'))
from file_store import file_date  # noqa: E402


def short_name(entry, fingerprint: str) -> str:
    base = re.sub(r'\s*\[[0-9a-f]{16,64}\]$', '', os.path.splitext(entry.get('drive_name') or '')[0])
    return re.sub(r'[^a-z0-9]+', '-', base.lower()).strip('-') or fingerprint


def links_table(files):
    """[(name, link, file, uploaded)], sorted by name."""
    groups = {}
    for fingerprint, entry in files.items():
        if entry.get('drive_link'):
            groups.setdefault(short_name(entry, fingerprint), []).append((fingerprint, entry))
    rows = []
    for name, members in groups.items():
        members.sort(key=lambda item: file_date(item[1]) or 0, reverse=True)
        names = [name] if len(members) == 1 else [name] + [f'{name}-{fp}' for fp, _ in members]
        for row_name in names:
            fingerprint, entry = members[0] if row_name == name else next(m for m in members if row_name.endswith(m[0]))
            when = file_date(entry)
            uploaded = datetime.fromtimestamp(when, timezone.utc).strftime('%Y-%m-%d') if when else ''
            rows.append((row_name, entry['drive_link'], entry['drive_name'], uploaded))
    return sorted(rows)


def main(argv):
    if len(argv) != 3:
        print(__doc__.split('\n\n')[1])
        return 1
    files = json.loads(Path(argv[1]).read_text(encoding='utf-8'))['files']
    rows = links_table(files)
    with open(argv[2], 'w', encoding='utf-8', newline='') as out:
        writer = csv.writer(out)
        writer.writerow(['name', 'link', 'file', 'uploaded'])
        writer.writerows(rows)
    print(f"{len(rows)} names for {sum(1 for e in files.values() if e.get('drive_link'))} shared files written to {argv[2]}")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
