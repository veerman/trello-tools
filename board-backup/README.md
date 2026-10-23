# Board Backup

Saves every board in the workspaces you choose as Markdown, made to live in a private git repo so you can follow your boards over time. Python 3, standard library only, on Windows, Mac, or Linux.

Run `python backup.py`. Every run fetches every board again; git records only what actually changed.

## What it writes

```
backup/                               (BACKUP_DIR: make this a private git repo)
  boards/
    Project Roadmap [<board id>].md     one file per board
  attachments.json                    index of every stored file and every link
  board-choices.json                  which boards to keep (from review_boards.py)
  files/                              (FILE_STORE: listed in .gitignore, so it stays out of git)
    3f2a9c1b7d4e5a60.docx             each file once, named by its fingerprint
excluded/                             (EXCLUDED_DIR: boards not marked In; never in git or on Drive)
  boards/  files/  attachments.json   the same layout, for the excluded side
```

The file store sits inside the backup folder and is kept out of git: the scripts add it to the backup folder's `.gitignore` and refuse to run if git would commit it. The excluded folder must be separate from both.

- **One Markdown file per board**, in the shared schema (board-editor/trello-markdown-guide.md). It starts with the board's details (id, link, workspace, created, last activity), includes card comments under `###### Comments`, and leaves out archived lists and cards. A renamed board replaces its old file, so git sees a rename. Board files sit directly in `boards/` (the workspace is in each file's details), so give each workspace its own backup folder.
- **Each attachment is stored once**, named by its fingerprint: the first 16 hex digits of the file's SHA-256. The same file on fifteen boards is one file; a changed file gets a new fingerprint, so older versions stay in the store. The board's Markdown shows the fingerprint after the link, like `- [Plan.docx](https://... "sha256:3f2a9c1b7d4e5a60")`, so you can tell it is the same file even when the links differ.
- **attachments.json** lists every stored file (names, size, type, first upload date, the links it came from, and the board, list, and card where it is used) and every plain link (Google Docs, web pages, and downloads that failed, marked `not_stored`). Runs use it to skip files they already have.

Trello uploads are downloaded with your login. Google Docs and web pages stay links. The login is only ever sent to trello.com.

## Setup

Copy `.env.example` to `.env`, fill in your key and token, and optionally set:

- `BACKUP_WORKSPACES`: the workspaces to back up, so the run doesn't ask.
- `BACKUP_DIR`: where the board files go, with the file store in its `files/` folder. Relative paths are relative to this folder. The file store stays out of git: it only grows, and git keeps every version forever. `FILE_STORE` puts the store somewhere else.
- `EXCLUDED_DIR`: where boards that aren't marked In go (see below). Keep it apart from the backup folder.

## Choose the boards

A workspace can hold boards that shouldn't be in a shared backup: someone's personal board you were added to, or a board full of email attachments. `python review_boards.py` opens a page on this computer listing every board: who made it, who is on it and your role, whether it is private, when it was last used, and all its files. Boards that may be personal are flagged (one member, private, email or personal-looking files). Mark each board In or Out; every click is saved to `board-choices.json` in the backup folder.

After the first review, a board is **included** only when it is marked In; every other board is **excluded**, and its files go with it:

- Included boards and their files stay in the backup folder and the file store. `backup.py` backs up only these, and `upload_to_drive.py` uploads only their files.
- Excluded boards' last copies and their files are moved to the excluded folder (`EXCLUDED_DIR`), which stays on this computer: never in git, never on Drive. Delete it whenever you like.
- A file used on an included board is included. If an excluded board uses it too, the excluded folder gets its own copy, so each side is complete and never refers to the other. Each side's attachments.json names only its own boards. A file whose boards aren't known is excluded.
- Change your mind any time: run the review again. When you stop it (and at the start of every backup run), boards and files whose choice changed move to the right side. The three folders must be separate; the scripts refuse to run otherwise.

A new board stays out until you mark it In; each backup run says how many haven't been reviewed. Boards with "roadmap" or "phase <number>" in the name start as In. board-choices.json keeps the In boards' names and only the ids of Out boards.

## Copy the files to Google Drive

`upload_to_drive.py` copies the file store into one Google Drive folder with [rclone](https://rclone.org), named like `Project Plan (Draft) [3f2a9c1b7d4e5a60].pdf`. It only ever adds:

- `python upload_to_drive.py --connect` once: it prints a sign-in link. Open it in a private window (a browser signed in to several Google accounts can get a "400" error from Google), sign in to the Google account, and approve. The connection uses Google's "only files this app creates" permission, so rclone can't see anything else in that Drive, let alone delete it. The script refuses any connection without that permission.
- `python upload_to_drive.py`: a dry run that lists what would be uploaded and uploads nothing.
- `python upload_to_drive.py --upload`: uploads the included files that aren't there yet, and sets each file's date in Drive to when it was first uploaded to Trello. Uploads only ever run `rclone copy --immutable`: it adds files and refuses to change any that are there. A date is set only on a file whose bytes match the laptop copy exactly.
- `python upload_to_drive.py --share`: lists the files not yet viewable by link; add `--confirm` to share them. Each file is shared on its own ("anyone with the link can view"), never the folder, so a board can link to any file while nobody can see what else is in the folder. Each file's link is saved in attachments.json as `drive_link`. Run it after uploading new files. Sharing a file moves its Drive date to the moment it was shared, so the order is: share first, then set the dates; `--share --confirm` does both, putting each file's upload date back right after sharing it.
- `python upload_to_drive.py --remove-excluded`: lists the files in the folder that aren't on any In board (for after you exclude a board). Add `--confirm` to delete them, permanently, so they don't sit in the shared account's trash. Only files named in that list are deleted, never folders, and never a file that is also on an In board.

Set `DRIVE_REMOTE` and `DRIVE_FOLDER` in `.env`. Let the first upload create the folder: because of the permission, rclone can't see a folder you made yourself and would make a second one. Each file's Drive name is chosen once and kept in attachments.json as `drive_name`, so it is never uploaded twice.

## Files

- backup.py: the run. Lists your workspaces, backs up each board, saves after every board, and ends with a summary of anything that failed.
- board_markdown.py: board JSON to Markdown. Must match the editor's exporter; tests/fixtures checks both.
- file_store.py: the file store and attachments.json.
- board_choices.py: which boards are included, and keeping included and excluded boards and files apart (above).
- env.py: reads `.env`. Variables already set in your environment win.
- review_boards.py and review_boards.html: the board review (above). The page only works while the script runs, and only on this computer.
- upload_to_drive.py: copies the file store to Google Drive (above).
- attachments.html: the Attachment Manager, a page for browsing attachments.json. It shows every stored file and link, how many places use it, and the boards, lists, and cards where it appears (newest board first). Search supports OR, NOT, and a use-count filter like `>= 2` for files shared between boards, and the filters stay in the page address. It loads `backup/attachments.json` and opens files from `backup/files/` by default; add `?data=<backup folder>` (and `&files=<file store>` if the store is somewhere else) to point it elsewhere, or use Open attachments.json.
