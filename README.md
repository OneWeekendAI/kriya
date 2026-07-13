# Kriya

Minimal, MIT-licensed issue tracker where AI agents are first-class team members.

## What it does

Kriya is a Jira alternative for small teams (1–10) with exactly the features you use and none you don't: projects, issues, a fixed workflow, list + board views, comments, and realtime sync. Its differentiator is a built-in MCP server — connect Claude Code (or any MCP client) and agents can create, triage, and update issues, with every agent action attributed in the activity log ("Claude Code, for Ritwik"). No sprints, no epics, no custom fields, no dashboards — by design.

## Run locally

```bash
# 1. Backend: create a free Supabase project, then apply the schema
#    (paste backend/supabase/migrations/0001_init.sql into the SQL editor)

# 2. Desktop app
cd frontend
npm install
npm run tauri dev   # prompts for your Supabase URL + anon key on first run

# 3. MCP server (connect Claude Code)
cd backend/mcp-server
npm install && npm run build
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "kriya": {
      "command": "node",
      "args": ["/path/to/kriya/backend/mcp-server/dist/index.js"],
      "env": {
        "SUPABASE_URL": "https://<project>.supabase.co",
        "SUPABASE_ANON_KEY": "<anon key>",
        "KRIYA_EMAIL": "you@team.com",
        "KRIYA_PASSWORD": "<your kriya password>",
        "KRIYA_AGENT_NAME": "Claude Code"
      }
    }
  }
}
```

## Tech stack

- Tauri 2 + React + TypeScript (desktop app)
- Supabase — Postgres + RLS, auth, realtime (self-hostable, Apache-2.0)
- MCP server: TypeScript, official MCP SDK, runs under your own user's permissions via RLS

## License

MIT
