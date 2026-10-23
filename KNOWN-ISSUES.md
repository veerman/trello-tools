# Known Issues

Planned work and current limits, most important first.

## 1. File attachments on new boards

Cause: both exporters write `##### Attachments` entries using the attachment's `url` field. For uploaded files that is `https://trello.com/1/cards/<cardId>/attachments/<attId>/download/<name>`. On Save to Trello, script.js does `POST cards/{id}/attachments` with `{url, name}`, which creates a link attachment pointing at the old card. Trello authorizes downloads against the old card's board, so the file opens only for people who can see that board.

The current direction: link files from a shared file library instead. The backup can copy each file to a Google Drive folder and share it by link (board-backup/upload_to_drive.py), and file-links gives each file a stable name. Other options:

1. Re-upload in the editor. When importing, detect `trello.com/1/cards/.../download/` URLs, fetch the bytes with the OAuth header (`Authorization: OAuth oauth_consumer_key="KEY", oauth_token="TOKEN"`, the same header file_store.py uses), then `POST cards/{id}/attachments` as multipart form data with a `file` field. Keeps the editor self-contained. Checked 2026-10-23: the download address answers the browser's preflight with `access-control-allow-origin: *` and allows the `Authorization` header, from both trello.com and api.trello.com. Still to confirm with a real login: that the signed-in download response (or the file storage it may redirect to) also carries that header, so the page can read the file.
2. Upload from the file store. The backup keeps each file once, named by its fingerprint, and its Markdown shows the fingerprint after each attachment link. The editor can ask for the file store folder and upload each file from there as multipart form data. Works regardless of CORS and needs no server.
3. Copy the board with Trello's own copy (`POST /boards` with `idBoardSource` and `keepFromSource=cards`), which duplicates attachments correctly, then apply the Markdown as a diff on top of the copy. Bigger redesign, but it is also the natural base for change management (section 2), since every new version becomes "copy the last board, apply changes."

The Markdown already carries what an importer needs to tell files from links: uploaded files are the links that match `trello.com/1/cards/<cardId>/attachments/<attId>/download/<name>`, and anything else is a plain link.

## 2. Following boards over time

Done: lines of board versions (lineage.py, lineage.json) and one history file per line whose git history shows each version (see board-backup/README.md). Optional next: a change list for each step, with "why" and "temporary?" to fill in, and a "made from" stamp when the editor creates a board.

## 3. Small things

- backup.py only backs up open boards you are a member of, so closed boards, and workspace boards you haven't joined, are missing. A board closed after an earlier run keeps its last file.
