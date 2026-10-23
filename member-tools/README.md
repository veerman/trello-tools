# Member Tools

One page, index.html (the Member Manager), for workspace-level membership (not board-level). It uses the shared login in ../shared/trello.js.

- Workspaces: lists every workspace you belong to and marks the ones where you are an admin. Click a name to see its members.
- Members: shows a workspace's members with their role, removes a member (`DELETE organizations/{id}/members/{idMember}`), and shows which of your other workspaces a member is in (click their name).
- Add a person: enter a Trello username or an email (or pick someone from a JSON list), tick the workspaces, and add them to all of them in one run (`PUT organizations/{id}/members`). Only admin workspaces can be ticked. Anyone who is already a member of a ticked workspace is skipped, because the same Trello call also changes an existing member's role. Built for setups with one workspace per team or client, where a new teammate has to be added to many workspaces at once.

The JSON list is a file like this; each person needs at least one of `id`, `trello_username`, or `email`:

```json
{
  "eligible_members": [
    { "name": "Sam Lee", "trello_username": "samlee" },
    { "name": "Alex Kim", "email": "alex@example.com" }
  ]
}
```

Still to test against real Trello: adding by email, and adding from the JSON list. Notes from testing (Jan 2026): adding a member to a free-tier workspace makes them a workspace admin. Adding to the workspace does not add them to any board, which is the desired behaviour.

Run: host the member-tools and shared folders on any static host, or from the repo root run `python -m http.server 8000` and open http://localhost:8000/member-tools/. Connect with your own API key (see Setup in the main README).
