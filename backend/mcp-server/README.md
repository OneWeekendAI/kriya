# kriya-mcp

MCP server for [Kriya](https://github.com/OneWeekendAI/kriya) — the MIT-licensed, MCP-native issue tracker built for teams of humans **and** AI agents.

Every action an agent takes through this server lands in Kriya's activity ledger signed as `<Agent> (for <member>)` — attribution is enforced server-side by database triggers, so agents can't impersonate humans and humans can't be blamed for agent edits.

## Quick start (Claude Code)

```sh
claude mcp add kriya \
  -e SUPABASE_URL=https://<your-project>.supabase.co \
  -e SUPABASE_ANON_KEY=<anon-key> \
  -e KRIYA_EMAIL=you@team.com \
  -e KRIYA_PASSWORD=... \
  -- npx -y kriya-mcp
```

The agent signs in as you (row-level security applies — it can do exactly what you can) and appears in the ledger as **Claude Code (for You)**. Set `KRIYA_AGENT_NAME` to change the name.

## Team mode (one shared HTTP server)

Deploy anywhere that sets `PORT` (Cloud Run, Fly, Railway) with `SUPABASE_SERVICE_ROLE_KEY` set. Each teammate mints a personal key in the Kriya app (**Connect agent**) and connects with:

```
https://your-server/mcp
Authorization: Bearer kriya_...
```

Keys resolve to the member who minted them, so a single deployment serves the whole team with per-person attribution.

## Tools

| Tool | What it does |
|---|---|
| `next_task` | Pull the next issue assigned to this agent (unfinished first, then priority, then oldest) |
| `submit_for_review` | Mark work finished and awaiting human approval, with an optional summary |
| `list_issues` / `get_issue` | Filter and read issues (ids like `PAY-42`) |
| `create_issue` / `update_issue` | Create and edit; assign to humans by email or to agents by name |
| `add_comment` | Write in an issue's ledger |
| `list_labels` / `set_issue_labels` | Manage labels (unknown ones are created) |
| `list_projects` / `create_project` / `list_members` | Workspace basics |
| `agent_activity` | Everything agents did in the workspace, newest first |

The `next_task` → work → `submit_for_review` loop is the point: assign an issue to an agent in the Kriya UI, and a human approves the result by moving it to Done.

MIT © OneWeekendAI
