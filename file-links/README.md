# File Links

Links that always open the current version of a file, even after someone replaces it with a new upload. A board links to

    https://<where open.html is hosted>/open.html?f=project-plan

and the page jumps straight to whatever file that name points to today. When a file is replaced, change one row in a Google Sheet and every board that uses the name follows. Linking straight to a file still works too; this is for files that change.

Private by design: the list of names and files stays in a private Sheet. A small Apps Script attached to the Sheet answers one name at a time, so nobody can download the list, and the page holds no data.

## Pieces

- open.html: the redirect page. Host it anywhere that serves files (GitHub Pages, Netlify). It only ever jumps to `https` addresses.
- lookup.gs and appsscript.json: the Apps Script. `@OnlyCurrentDoc` and the `spreadsheets.currentonly` scope limit it to its own Sheet: it cannot see, change, or delete anything else in the Drive. It caches the list for five minutes, so an edit to the Sheet can take that long to show.

## Setup

1. Create a Google Sheet. Its first tab (or a tab named `Links`) has `name` and `link` in the first row, then one row per file: the short name used after `?f=`, and the file's share link. Names match ignoring case, and spaces, dashes, and underscores count as the same. To start from a backup's files shared to Drive, `python links_table.py <backup folder>/attachments.json links.csv` writes the table (one short name per file, the newest version under a shared name), ready for File > Import.
2. In the Sheet: **Extensions > Apps Script**. Replace the contents of `Code.gs` with `lookup.gs`. The `@OnlyCurrentDoc` line already limits it to this Sheet; to match `appsscript.json` exactly, tick "Show appsscript.json manifest file in editor" in **Project Settings** and replace it with the one here (optional).
3. **Deploy > New deployment**, type **Web app**, execute as **Me**, access **Anyone**. Approve the access it asks for (only this spreadsheet) and copy the web app address.
4. Put that address in `LOOKUP_URL` at the top of `open.html` and host the page.

Keep the Sheet itself private. For the files in Drive, share each file as "Anyone with the link: Viewer" and keep their folder shared with your team only, so a file link works for anyone but the folder doesn't open for outsiders.

After changing the script later, use **Deploy > Manage deployments > Edit > New version** so the web app address stays the same.
