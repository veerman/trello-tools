"""The file store: every attachment kept once, named by its fingerprint, however many boards
link to it. attachments.json is the index: every stored file and every plain link, with the
places (board, list, card) where each one is used, and the boards each file has ever been on.

The fingerprint is the first 16 hex digits of the file's SHA-256, so it is the same on every
computer and changes whenever the file's bytes change. Each stored file is dated when it was
first uploaded to Trello.
"""
import hashlib
import json
import mimetypes
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import unquote, urlparse

TRELLO_HOSTS = {'trello.com', 'api.trello.com'}

def is_trello_host(url: str) -> bool:
    # Exact host match: a substring check would also match trello.com.example.net
    return (urlparse(url).hostname or '').lower() in TRELLO_HOSTS

class StripAuthOnForeignRedirect(urllib.request.HTTPRedirectHandler):
    # urllib copies every header onto a redirected request, Authorization included.
    # Drop it when a redirect leaves Trello so the token never reaches another host.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None and not is_trello_host(newurl):
            new_req.remove_header('Authorization')
        return new_req

opener = urllib.request.build_opener(StripAuthOnForeignRedirect)

def is_downloadable_resource(url: str) -> bool:
    """Trello uploads and direct links to files are stored; Google Docs and web pages stay links."""
    parsed_url = urlparse(url)
    if parsed_url.netloc in ['docs.google.com', 'drive.google.com']:
        return False
    if re.search(r'/attachments/([a-fA-F0-9]+)/', url):
        return True
    path = parsed_url.path.lower()
    if not path or path.endswith('/'):
        return False
    basename = os.path.basename(path)
    if '.' not in basename:
        return False
    return os.path.splitext(basename)[1] not in ['.html', '.htm', '.php', '.aspx', '.asp', '.jsp', '.cgi']

def extension_for(*names: str) -> str:
    """The first sensible file extension among a file name, an attachment name, or a URL."""
    for name in names:
        if not name:
            continue
        path = unquote(urlparse(name).path) if '://' in name else name
        ext = os.path.splitext(path)[1].lower()
        if re.fullmatch(r'\.[a-z0-9]{1,8}', ext):
            return ext
    return ''

def upload_time(url: str):
    """When a Trello upload was made, in seconds: an attachment id starts with its creation time
    as 8 hex digits. None for other links."""
    match = re.search(r'/attachments/([0-9a-f]{24})(/|$)', url) if is_trello_host(url) else None
    return int(match.group(1)[:8], 16) if match else None

def file_date(entry):
    """When the file was first uploaded to Trello, in seconds, or None if that isn't known."""
    times = [t for t in map(upload_time, entry.get('sources', [])) if t]
    if times:
        return min(times)
    if entry.get('first_uploaded'):
        return datetime.strptime(entry['first_uploaded'], '%Y-%m-%d').replace(tzinfo=timezone.utc).timestamp()
    return None

def download(url: str) -> bytes:
    headers = {'User-Agent': 'Mozilla/5.0'}
    api_key, api_token = os.environ.get('TRELLO_API_KEY'), os.environ.get('TRELLO_API_TOKEN')
    # Trello uploads need the login (required since 2021); other sites never see it
    if api_key and api_token and is_trello_host(url):
        headers['Authorization'] = f'OAuth oauth_consumer_key="{api_key}", oauth_token="{api_token}"'
    for attempt in range(2):
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=60) as response:
                return response.read()
        except HTTPError as e:
            # Trello's rate limit: wait and try once more
            if e.code == 429 and attempt == 0:
                time.sleep(10)
                continue
            raise


class FileStore:
    def __init__(self, store_dir, index_path):
        self.store_dir = Path(store_dir)
        self.index_path = Path(index_path)
        index = json.loads(self.index_path.read_text(encoding='utf-8')) if self.index_path.exists() else {}
        self.files = index.get('files', {})
        self.links = index.get('links', {})
        for entry in self.files.values():
            # Indexes from before seen_on: the boards a file is on now
            entry.setdefault('seen_on', sorted({place['board_id'] for place in entry['used_in']}))
        # A link already stored is not downloaded again
        self.by_url = {url: fp for fp, entry in self.files.items() for url in entry['sources']}
        self.downloaded = 0
        self.reused = 0
        self.failures = []

    def path_of(self, fingerprint: str) -> Path:
        return self.store_dir / self.files[fingerprint]['stored_as']

    def add_file(self, data: bytes, name: str = '', url: str = '', mime: str = '', uploaded: str = '') -> str:
        """Stores the bytes unless an identical file is already stored, and returns the fingerprint."""
        full = hashlib.sha256(data).hexdigest()
        fingerprint = full[:16]
        if fingerprint in self.files and self.files[fingerprint]['sha256'] != full:
            fingerprint = full  # two different files sharing 16 digits: practically never
        entry = self.files.get(fingerprint)
        if entry is None:
            entry = self.files[fingerprint] = {
                'sha256': full,
                'stored_as': fingerprint + extension_for(name, url),
                'size': len(data),
                'type': mime or mimetypes.guess_type(name or '')[0] or '',
                'names': [],
                'first_uploaded': None,
                'sources': [],
                'used_in': [],
                'seen_on': []
            }
        path = self.path_of(fingerprint)
        if not path.exists():
            self.store_dir.mkdir(parents=True, exist_ok=True)
            partial = path.with_name(path.name + '.part')
            partial.write_bytes(data)
            partial.replace(path)
        self._note(entry, name, url, uploaded)
        if url:
            self.by_url[url] = fingerprint
        return fingerprint

    def _note(self, entry, name, url, uploaded):
        if name and name not in entry['names']:
            entry['names'] = sorted(entry['names'] + [name])
        if url and url not in entry['sources']:
            entry['sources'] = sorted(entry['sources'] + [url])
        if uploaded and (not entry['first_uploaded'] or uploaded[:10] < entry['first_uploaded']):
            entry['first_uploaded'] = uploaded[:10]

    def store_attachment(self, att) -> str:
        """The fingerprint of the attachment's file, downloading it only if it is not stored yet.
        None for plain links, and for downloads that failed (listed in self.failures)."""
        url = att.get('url') or ''
        name = att.get('name') or att.get('fileName') or url
        known = self.by_url.get(url)
        if known and self.path_of(known).exists():
            self._note(self.files[known], name, url, att.get('date'))
            self.reused += 1
            return known
        if not url or not (att.get('isUpload') or is_downloadable_resource(url)):
            return None
        # A link that failed earlier in this run is not tried again for every board that has it
        if any(f['url'] == url for f in self.failures):
            return None
        try:
            data = download(url)
        except Exception as e:
            # The index keeps a short reason that stays the same between runs; the run prints the detail
            reason = f"HTTP {e.code}" if isinstance(e, HTTPError) else 'no response'
            self.failures.append({'name': name, 'url': url, 'error': str(e), 'reason': reason})
            return None
        self.downloaded += 1
        return self.add_file(data, att.get('fileName') or name, url, att.get('mimeType') or '', att.get('date') or '')

    def record_board(self, board_data, lists_and_cards) -> dict:
        """Stores the board's attachments and records where each file and link is used.
        Returns {attachment URL: fingerprint} for the board's Markdown."""
        board_id = board_data['id']
        # This board's places are recorded fresh, so removed attachments drop out
        for entry in list(self.files.values()) + list(self.links.values()):
            entry['used_in'] = [place for place in entry['used_in'] if place['board_id'] != board_id]

        fingerprints = {}
        for lst, cards in lists_and_cards:
            for card in cards:
                for att in card.get('attachments') or []:
                    url = att.get('url') or ''
                    fingerprint = self.store_attachment(att)
                    if fingerprint:
                        fingerprints[url] = fingerprint
                        entry = self.files[fingerprint]
                        # Kept after the file leaves the board, so an old version stays with its boards
                        if board_id not in entry['seen_on']:
                            entry['seen_on'] = sorted(entry['seen_on'] + [board_id])
                    else:
                        # Plain links, and files whose download failed (marked, so they can be found)
                        entry = self.links.setdefault(url, {'names': [], 'used_in': []})
                        self._note(entry, att.get('name') or url, '', '')
                        error = next((f['reason'] for f in self.failures if f['url'] == url), None)
                        if error:
                            entry['not_stored'] = error
                        else:
                            entry.pop('not_stored', None)
                    place = {'board': board_data['name'], 'board_id': board_id, 'list': lst['name'], 'card': card['name']}
                    if place not in entry['used_in']:
                        # The board id breaks ties between same-named boards, so the order never
                        # changes between runs (git would show it as a change)
                        entry['used_in'] = sorted(entry['used_in'] + [place],
                                                  key=lambda p: (p['board'], p['board_id'], p['list'], p['card']))
        return fingerprints

    def set_dates(self) -> int:
        """Dates each stored file when it was first uploaded to Trello. Returns how many changed."""
        changed = 0
        for entry in self.files.values():
            when, path = file_date(entry), self.store_dir / entry['stored_as']
            if when and path.exists() and abs(path.stat().st_mtime - when) > 1:
                os.utime(path, (when, when))
                changed += 1
        return changed

    def save(self):
        # A stored file stays in the index as history; a link no board uses any more is dropped
        self.links = {url: entry for url, entry in self.links.items() if entry['used_in']}
        index = {'files': dict(sorted(self.files.items())), 'links': dict(sorted(self.links.items()))}
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        partial = self.index_path.with_name(self.index_path.name + '.part')
        partial.write_text(json.dumps(index, indent=2, ensure_ascii=False) + '\n', encoding='utf-8', newline='\n')
        partial.replace(self.index_path)
