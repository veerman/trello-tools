# Trello Markdown Guide

## Welcome

This tool converts Markdown into Trello boards. Strict adherence to header hierarchy and formatting syntax is required to accurately map data to Boards, Lists, and Cards.

### 1. Structure Map

Select the corresponding style in the editor to create Trello objects.

| Markdown | Editor Style | Trello Object | Notes |
| --- | --- | --- | --- |
| `#` | **Heading 1** | Board Name | Defines the board title (use once). |
| `##` | **Heading 2** | List | Creates a new vertical column. |
| `###` | **Heading 3** | Card | Creates a card within the preceding List. |
| `####` | **Heading 4** | Checklist | Creates a checklist inside the preceding Card. |
| `#####` | **Heading 5** | Attachments | Special section for card links. |
| `######` | **Heading 6** | Comments | Read-only. Written by the backup tool for reference; ignored on Save to Trello. |

#### **Board Details (Front Matter)**

Exported boards start with a block between two `---` lines that records which Trello board the file came from: its id, link, workspace, creation date, and last activity. It is not board content, so the editor skips it on Save to Trello. Leave it unchanged.

```markdown
---
trello_board: 65a1b2c3d4e5f6a7b8c9d0e1
url: https://trello.com/b/AbCd1234
workspace: "My Workspace"
created: 2024-01-12
last_activity: 2026-01-03
---

# Product Launch Board
```

---

### 2. Card Features

#### **Card Covers (Colours)**

To apply a cover color to a card, add the color name in **square brackets** at the very end of the Heading 3 (Card) header.

* **Syntax:** `### Card Name [colour]`
* **Supported Colors:** `green`, `yellow`, `orange`, `red`, `purple`, `blue`, `sky`, `lime`, `pink`, `black`.
* **No cover:** exported cards without a cover end with an empty `[]`. Keep it: it marks the end of the title, so a title like `### Plan [Draft] []` keeps its bracketed word.

#### **Checklists**

Create a **Heading 4** header, append a single blank newline, and follow immediately with a dashed bulleted list.

```markdown
#### My Checklist

- Item 1
- Item 2

```

To mark an item as done, start it with `[x]`. Items without it are not done.

```markdown
#### My Checklist

- [x] Item 1
- Item 2

```

#### **Attachments**

Create a **Heading 5** header named exactly `Attachments`, append a single blank newline, and follow with a dashed bulleted list of markdown links. Every link must start with `http://` or `https://`.

```markdown
##### Attachments

- [Google](https://google.com)

```

Backups add each downloaded file's fingerprint after its link, like `- [Plan.docx](https://... "sha256:3f2a9c1b7d4e5a60")`. The same fingerprint on two boards means the same file, even when the links differ. Keep it as it is; the editor ignores it when saving.

#### **Descriptions**

Any normal text written directly under a **Heading 3 (Card)** header (separated by a single blank newline) becomes the card description. Write it before the card's checklists and attachments. Use **bold** for sub-headings: a line starting with `#` or `##` inside a description is read as a new board title or a new list. Exports turn any heading inside a Trello description into bold for the same reason. Trello allows at most 16,384 characters per description.

#### **Comments**

Boards exported by the backup tool may end a card with a **Heading 6** section named `Comments`, listing the card's comments. It is for reference only: the editor ignores it and never recreates comments. Leave it unchanged.

---

### 3. Example Template

```markdown
# Product Launch Board

## To Do

### Design Mockups [blue]

Please use the new brand guidelines.

#### Requirements

- Mobile view
- Desktop view

##### Attachments

- [Figma Link](https://figma.com/file/xyz)

## In Progress

### Backend API [red]

Setting up the endpoints for the user auth.

## Done

### Project Kickoff [green]

Meeting notes attached.

```

---

### 4. Strict Parsing Requirements

The editor's **Check** applies these rules before Save to Trello and reports any break by line number.

* **Do not skip levels:** Do not place an H3 (Card) directly under an H1 (Board) without an H2 (List) in between. It will result in an "Unlisted" column.
* **One board title:** Use `#` once. A second `#` line replaces the board name.
* **Known headings only:** An H5 must be exactly `##### Attachments` and an H6 exactly `###### Comments`. Any other H5 or H6 becomes plain description text.
* **Only items under checklists and attachments:** Under a `####` checklist or `##### Attachments`, only `- ` items are kept. Any other text there is ignored, so put it in the description above.
* **No loose text:** Text before the first list, or between a list and its first card, is ignored. Boards and lists have no descriptions.
* **Bullet Syntax:** Use a hyphen/dash (`-`) for every list item. Asterisks (`*`) are accepted and converted to dashes. Plus signs (`+`) and numbered items are ignored under checklists and attachments.
* **Heading Spacing:** A blank line after each heading is recommended. Checklist items and attachment links may also follow their heading directly, which is how exports write them.
