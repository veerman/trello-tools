# Board Editor

Single-page app: index.html, script.js, style.css. Uses Tailwind (CDN), Font Awesome, and Toast UI Editor.

What it does:

1. Connect to Trello with your own API key (see Setup in the main README). The key, the login, and the API calls live in ../shared/trello.js and are shared with the member manager.
2. Pick a workspace, then a board, and load it as Markdown following trello-markdown-guide.md. You can also load from a file or from a URL (a Trello board link or a link to a Markdown file).
3. Edit in Markdown or WYSIWYG mode. Views: Markdown, MD/Doc, Doc, MD/Board, Board, plus View on Trello.
4. Save to file (filename derived from the board name, stamped with the date and time).
5. Save to Trello: parses the Markdown and creates a brand new board in the chosen workspace, list by list, card by card, including cover colours, checklists (with ticks), and attachments. Rate-limit guard pauses every 80 requests.

Board check: the summary next to the Editor heading updates as you edit and opens a report with three parts. Problems (attachments that are not web links, descriptions over Trello's limit, nothing to create) block Save to Trello. Warnings point to content Save to Trello would ignore, by line number. Changes compare with the original: the board loaded from Trello, or the first file loaded if there was none, so an AI-edited file is compared with the export it came from. Save to Trello shows the report first whenever it has anything in it. "Copy report" puts it on the clipboard as plain text for an AI tool.

Paste from Word: paste a Word document into the Doc view and the editor rebuilds the board from its bold lines. The first bold line becomes the board title, a bold line ending in a cover colour like `[green]` becomes a card, and a bold line just before a card becomes a list. Everything else stays as card text.

Board details: exports start with a front matter block (the board's id, link, workspace, creation date, and last activity). The editor keeps it intact in every view and skips it on Save to Trello.

Help menu:

- Updates Guide: opens updates-guide.html, the step-by-step process for updating a board.
- Modify Board Prompt: shows prompt_modify.txt with the Markdown guide filled in, ready to copy into an AI tool along with a chunk of the board and a list of changes.
- Query Board Prompt: same, with prompt_query.txt, for asking questions about a board without changing it.
- Compare Markdown: links to external diff sites for checking the old file against the new one.

The editor fetches trello-markdown-guide.md, prompt_modify.txt, and prompt_query.txt from its own folder, so keep them next to index.html.

URL parameters: `?url=<trello board or markdown url>` loads that board or file on open, `?view=<mode>` picks the starting view, and `?api_key=<key>` saves a shared Trello API key in the browser (then leaves the address).

Attachments are added as links (`POST cards/{id}/attachments` with `url`). A file uploaded to another board keeps that board's link, so it opens for people who can see that board; linking files from a shared file library instead is planned (KNOWN-ISSUES.md).

Run: host the board-editor and shared folders on any static host, or from the repo root run `python -m http.server 8000` and open http://localhost:8000/board-editor/.
