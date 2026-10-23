# Known Issues

Planned work and current limits, most important first.

## 1. File attachments on new boards

Cause: both exporters write `##### Attachments` entries using the attachment's `url` field. For uploaded files that is `https://trello.com/1/cards/<cardId>/attachments/<attId>/download/<name>`. On Save to Trello, script.js does `POST cards/{id}/attachments` with `{url, name}`, which creates a link attachment pointing at the old card. Trello authorizes downloads against the old card's board, so the file opens only for people who can see that board.

The current direction: link files from a shared file library instead. The backup can copy each file to a Google Drive folder and share it by link (board-backup/upload_to_drive.py), and file-links gives each file a stable name. Other options:

1. Re-upload in the editor. When importing, detect `trello.com/1/cards/.../download/` URLs, fetch the bytes with the OAuth header (`Authorization: OAuth oauth_consumer_key="KEY", oauth_token="TOKEN"`, the same header file_store.py uses), then `POST cards/{id}/attachments` as multipart form data with a `file` field. Keeps the editor self-contained. Unverified risk: the trello.com download endpoint may not send CORS headers, in which case the browser cannot read the response and this option is dead. Test that first with a single fetch from the console.
2. Upload from the file store. The backup keeps each file once, named by its fingerprint, and its Markdown shows the fingerprint after each attachment link. The editor can ask for the file store folder and upload each file from there as multipart form data. Works regardless of CORS and needs no server.
3. Copy the board with Trello's own copy (`POST /boards` with `idBoardSource` and `keepFromSource=cards`), which duplicates attachments correctly, then apply the Markdown as a diff on top of the copy. Bigger redesign, but it is also the natural base for change management (see section 4), since every new version becomes "copy the last board, apply changes."

The Markdown already carries what an importer needs to tell files from links: uploaded files are the links that match `trello.com/1/cards/<cardId>/attachments/<attId>/download/<name>`, and anything else is a plain link.

## 2. Duplicate board names

Each backed-up board's file name ends with its id, so duplicates are safe on disk, but any tool that groups boards by name needs a rule for which of two same-named boards is canonical. The planned lineage file (section 4) settles it by hand, helped by creation dates and card counts.

## 3. Small things

- backup.py only backs up open boards you are a member of, so closed boards, and workspace boards you haven't joined, are missing. A board closed after an earlier run keeps its last file.
- The backup asks Trello for at most 1000 comments per board (the API maximum), so very busy boards lose their oldest comments.
- Not in the format yet: labels, due dates, members, and custom fields. Headings inside a card description export as bold text, so they can't break the board structure.
- The editor has no built-in diff between two exports. Help > Compare Markdown links to external comparison sites instead.

## 4. Following boards over time

Done: the backup is made for a private git repo. Each board is one Markdown file that starts with its details (id, link, created, last activity), and each attachment is stored once, named by its fingerprint, so the same file is recognisable across boards even when its links differ.

Next:

1. A lineage file that says which boards are versions of the same board (for example the same roadmap re-issued every term under a new name), in order. Drafts and staging boards are marked as side boards, and a line can note that it started from another line's board. A small page helps group and order boards, using creation dates and suggesting groups from shared card titles.
2. One history file per line, holding its newest board, so that file's git history shows every change from version to version. Backfilled from older backups.
3. Optional: a change list for each step, with "why" and "temporary?" to fill in, and a "made from" stamp when the editor creates a board.
