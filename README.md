# Trello Tools

A small set of tools for managing Trello boards as plain text, backing them up, and administering workspace members. Built for teams that re-issue the same boards on a schedule (each semester, quarter, or project cycle) and want to edit, version, and copy them as Markdown.

Planned work and current limits are listed in KNOWN-ISSUES.md.

## Tools

- **board-editor/**: a browser app. Loads a Trello board as Markdown, lets you edit it (Markdown or WYSIWYG), saves to file, and creates a new board from the Markdown. Checks the board before saving and shows what changed since the original. Also holds the Markdown guide, two AI prompts (modify a board, query a board), and the updates guide.
- **board-backup/**: a Python script for version control. Saves each board as one Markdown file for a private git repo, and stores each attachment once, named by its fingerprint, with an index of where every file is used. Includes a page for choosing which boards to keep, the Attachment Manager for browsing the index, and a safe copy of the files to Google Drive.
- **member-tools/**: a browser page for workspace membership: see each workspace's members, remove people, see which workspaces a person is in, and add one person to many workspaces in one run.
- **file-links/**: a redirect page plus a small Google Apps Script: links like `?f=project-plan` that always open the current version of a file, looked up by name in a private Google Sheet.

## The Markdown schema

All tools share one convention: `#` board, `##` list, `###` card (with `[colour]` suffix for cover), `####` checklist (`- [x]` marks a done item), `#####` Attachments, and a read-only `######` Comments section that only the backup writes. Archived lists and cards are left out. Full rules in board-editor/trello-markdown-guide.md.

## Tests

Each file in tests/ runs on its own: `node tests/<name>.test.js` for the pages and `python tests/test_<name>.py` for the backup (the Drive test's last part needs rclone installed). Both exporters are checked against the same sample board in tests/fixtures, so their Markdown can't drift apart, and the board check is tested against the same files. Nothing to install beyond Node and Python.

## Setup

### Board editor and member manager

Plain web pages with no server code. Put the `board-editor`, `member-tools`, and `shared` folders on any static host (GitHub Pages, Netlify, any web server) and open `board-editor/` or `member-tools/`. To run them on your own computer instead, run `python -m http.server 8000` in the repo folder and open http://localhost:8000/board-editor/.

Each person brings their own Trello API key. Click **Connect to Trello**, paste the key, and approve on Trello. The key and the login are kept only in that browser, both pages share them, and Disconnect cancels the login at Trello.

To get a key:

1. Create a Power-Up at https://trello.com/power-ups/admin. Any name works; it only holds the key.
2. On its **API key** page, generate a key.
3. On the same page, add the address you open the pages from (for example `https://you.github.io` or `http://localhost:8000`) to **Allowed origins**, so Trello can send you back after you approve. If you can't, use "paste a token instead" in the Connect dialog.

Hosting for a team? Put your key in `DEFAULT_TRELLO_API_KEY` at the top of `shared/trello.js`. People then only click Connect and approve, and only your key needs the allowed origin.

### Board backup

A Python script you run on your own computer. Copy `.env.example` to `.env`, fill in key and token, choose where the backup and the file store go (see board-backup/README.md), then run `python backup.py`. Standard library only, nothing to install.
