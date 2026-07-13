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

### Remote MCP (recommended — one URL for the whole team)

The same server speaks MCP's Streamable HTTP transport when `PORT` is set. Deploy it anywhere that runs containers (Cloud Run shown):

```bash
cd backend/mcp-server
gcloud run deploy kriya-mcp --source . --region asia-south1 --allow-unauthenticated \
  --set-env-vars "SUPABASE_URL=https://<project>.supabase.co,SUPABASE_ANON_KEY=<anon key>,KRIYA_EMAIL=<agent user email>,KRIYA_PASSWORD=<password>,KRIYA_AGENT_NAME=Claude,MCP_AUTH_TOKEN=<random secret>"
```

(`--allow-unauthenticated` exposes the URL; the server enforces its own `Authorization: Bearer <MCP_AUTH_TOKEN>` on every MCP request.) Then connect from Claude Code:

```bash
claude mcp add --transport http kriya https://<cloud-run-url>/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

### Local MCP (stdio)

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

## GitHub

Mention an issue id like `KRI-42` in a PR title or branch name and Kriya keeps the issue in sync — PR opened moves it to In Progress, PR merged moves it to Done, each with a comment linking the PR, attributed in the activity log as agent "GitHub". Setup is one Edge Function, dashboard-only:

1. Supabase dashboard → Edge Functions → Deploy new function → name it `github-webhook`, paste `backend/supabase/functions/github-webhook/index.ts`, and turn OFF "Verify JWT" in its details.
2. Add the secret `GITHUB_WEBHOOK_SECRET=<any random string>` under Edge Function secrets.
3. GitHub repo → Settings → Webhooks → add `https://<project>.supabase.co/functions/v1/github-webhook`, content type `application/json`, the same secret, events: "Pull requests" only.

For richer flows, skip the webhook entirely: your coding agent is already connected to both GitHub and Kriya. Add this to your project's CLAUDE.md and the agent maintains the tracker itself:

```markdown
When you open, merge, or close a PR for an issue tracked in Kriya (ids like
KRI-42), update that issue via the kriya MCP tools: set status accordingly
and add a comment linking the PR.
```

## Tech stack

- Tauri 2 + React + TypeScript (desktop app)
- Supabase — Postgres + RLS, auth, realtime (self-hostable, Apache-2.0)
- MCP server: TypeScript, official MCP SDK, runs under your own user's permissions via RLS

## License

MIT
