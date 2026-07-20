#!/usr/bin/env node
/**
 * Kriya MCP server. Attribution rides on the x-kriya-agent request header:
 * Postgres triggers stamp it onto every write server-side, so the activity
 * log shows "Claude Code (for <member>)" and this process never touches
 * attribution columns directly.
 *
 * Two ways to run:
 *
 *   stdio (local, single user) — signs in as a real Kriya member (RLS
 *   applies; the agent can do exactly what its human can).
 *   Env: SUPABASE_URL, SUPABASE_ANON_KEY, KRIYA_EMAIL, KRIYA_PASSWORD,
 *        KRIYA_AGENT_NAME (optional, default "Claude Code")
 *
 *   HTTP (remote, whole team) — set PORT (Cloud Run does). Each member mints
 *   personal agent keys in the app ("Connect your agent"); requests carry
 *   `Authorization: Bearer kriya_...` and the server resolves the key to that
 *   member, forwarding identity via the x-kriya-actor header (honored by the
 *   database only on service-role requests, so clients can't spoof it).
 *   Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *   Optional legacy shared-token mode: MCP_AUTH_TOKEN + KRIYA_EMAIL/PASSWORD.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import { z } from "zod";

const AGENT = process.env.KRIYA_AGENT_NAME ?? "Claude Code";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_ANON_KEY = env("SUPABASE_ANON_KEY");

const STATUSES = ["backlog", "todo", "in_progress", "done", "cancelled"] as const;
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

const statusZ = z.enum(STATUSES);
const priorityZ = z.enum(PRIORITIES);

function fail(msg: string): never {
  throw new Error(msg);
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// PostgREST or() filters treat commas/parens as syntax; strip them from user input.
function likePattern(search: string): string {
  return `%${search.replace(/[,()]/g, " ").trim()}%`;
}

function createServer(supabase: SupabaseClient, agentName: string, workspaceId: string): McpServer {
  const server = new McpServer({ name: "kriya", version: "0.1.0" });

  async function projectByKey(key: string) {
    const { data, error } = await supabase.from("projects").select("*")
      .eq("workspace_id", workspaceId)
      .eq("key", key.toUpperCase()).single();
    if (error || !data) fail(`No project with key '${key}'`);
    return data;
  }

  async function issueRef(projectKey: string, number: number) {
    const project = await projectByKey(projectKey);
    const { data, error } = await supabase
      .from("issues").select("*").eq("project_id", project.id).eq("number", number).single();
    if (error || !data) fail(`No issue ${projectKey.toUpperCase()}-${number}`);
    return { project, issue: data };
  }

  // Every single-issue tool accepts id "KEY-42" (matches ids in list_issues
  // output) or the legacy project_key + number pair.
  const issueIdArgs = {
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,7}-\d+$/).optional()
      .describe("Issue id like 'PAY-42' (preferred)"),
    project_key: z.string().optional().describe("Legacy alternative to id, with number"),
    number: z.number().int().optional(),
  };

  async function issueFromArgs(args: { id?: string; project_key?: string; number?: number }) {
    if (args.id) {
      const dash = args.id.lastIndexOf("-");
      return issueRef(args.id.slice(0, dash), Number(args.id.slice(dash + 1)));
    }
    if (args.project_key && args.number !== undefined) return issueRef(args.project_key, args.number);
    fail("Pass id like 'PAY-42' (or project_key + number)");
  }

  async function memberByEmail(email: string) {
    const { data, error } = await supabase.from("workspace_members").select("*")
      .eq("workspace_id", workspaceId)
      .eq("email", email).single();
    if (error || !data) fail(`No member with email '${email}'`);
    return data;
  }

  // Fetch a name lookup {user_id → display_name} for this workspace, used to
  // hydrate assignee/author/actor columns after issue/comment/activity reads.
  // We do this in-process because auth.users isn't exposed via PostgREST, so
  // the previous embedded `members!fk` selects can't be replaced with an
  // embed against auth.users. One extra roundtrip per tool call.
  async function memberNames(): Promise<Map<string, { display_name: string; email: string }>> {
    const { data } = await supabase.from("workspace_members")
      .select("user_id, display_name, email")
      .eq("workspace_id", workspaceId);
    return new Map((data ?? []).map((m: any) => [m.user_id, { display_name: m.display_name, email: m.email }]));
  }

server.tool("list_projects", "List all projects in the workspace", {}, async () => {
  const { data, error } = await supabase.from("projects")
    .select("key, name, color, created_at")
    .eq("workspace_id", workspaceId)
    .order("name");
  if (error) fail(error.message);
  return json(data);
});

server.tool(
  "create_project",
  "Create a new project. Key is a short uppercase code like PAY or WEB.",
  { key: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,7}$/), name: z.string().min(1), color: z.string().optional() },
  async ({ key, name, color }) => {
    const { data, error } = await supabase
      .from("projects")
      .insert({ workspace_id: workspaceId, key: key.toUpperCase(), name, color })
      .select().single();
    if (error) fail(error.message);
    return json(data);
  }
);

server.tool("list_members", "List workspace members (for assigning issues)", {}, async () => {
  const { data, error } = await supabase.from("workspace_members")
    .select("display_name, email")
    .eq("workspace_id", workspaceId)
    .order("display_name");
  if (error) fail(error.message);
  return json(data);
});

server.tool(
  "list_issues",
  "List/filter issues. All filters optional; text search matches title and description.",
  {
    project_key: z.string().optional(),
    status: statusZ.optional(),
    priority: priorityZ.optional(),
    assignee_email: z.string().optional(),
    assignee_agent: z.string().optional().describe("Filter to issues assigned to this agent by name"),
    needs_review: z.boolean().optional().describe("Filter to issues awaiting (true) or not awaiting (false) human review"),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ project_key, status, priority, assignee_email, assignee_agent, needs_review, search, limit }) => {
    let q = supabase
      .from("issues")
      .select("number, title, status, priority, due_date, created_by_agent, assignee_id, assignee_agent, needs_review, created_at, projects!inner(key, workspace_id)")
      .eq("projects.workspace_id", workspaceId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (project_key) q = q.eq("projects.key", project_key.toUpperCase());
    if (status) q = q.eq("status", status);
    if (priority) q = q.eq("priority", priority);
    if (assignee_email) q = q.eq("assignee_id", (await memberByEmail(assignee_email)).user_id);
    if (assignee_agent) q = q.eq("assignee_agent", assignee_agent);
    if (needs_review !== undefined) q = q.eq("needs_review", needs_review);
    if (search) {
      const p = likePattern(search);
      q = q.or(`title.ilike.${p},description.ilike.${p}`);
    }
    const { data, error } = await q;
    if (error) fail(error.message);
    const names = await memberNames();
    return json(
      (data ?? []).map((i: any) => ({
        id: `${i.projects.key}-${i.number}`,
        title: i.title,
        status: i.status,
        priority: i.priority,
        assignee: i.assignee_id ? names.get(i.assignee_id)?.display_name ?? null : null,
        assignee_agent: i.assignee_agent,
        needs_review: i.needs_review,
        due_date: i.due_date,
        created_by_agent: i.created_by_agent,
      }))
    );
  }
);

server.tool(
  "get_issue",
  "Get one issue with its comments and full activity history. id like 'PAY-42'.",
  issueIdArgs,
  async (args) => {
    const { project, issue } = await issueFromArgs(args);
    const [{ data: comments }, { data: activity }, { data: labels }, names] = await Promise.all([
      supabase.from("comments")
        .select("body, agent_name, author_id, created_at")
        .eq("issue_id", issue.id).order("created_at"),
      supabase.from("activity")
        .select("action, old_value, new_value, agent_name, actor_id, created_at")
        .eq("issue_id", issue.id).order("created_at"),
      supabase.from("issue_labels").select("label:labels(name, color)").eq("issue_id", issue.id),
      memberNames(),
    ]);
    return json({
      id: `${project.key}-${issue.number}`,
      ...issue,
      labels: (labels ?? []).map((l: any) => l.label?.name),
      comments: (comments ?? []).map((c: any) => ({
        body: c.body, agent_name: c.agent_name, created_at: c.created_at,
        author: c.author_id ? names.get(c.author_id)?.display_name ?? null : null,
      })),
      activity: (activity ?? []).map((a: any) => ({
        action: a.action, old_value: a.old_value, new_value: a.new_value,
        agent_name: a.agent_name, created_at: a.created_at,
        actor: a.actor_id ? names.get(a.actor_id)?.display_name ?? null : null,
      })),
    });
  }
);

server.tool(
  "create_issue",
  "Create an issue in a project. Attribution to this agent is automatic.",
  {
    project_key: z.string(),
    title: z.string().min(1).max(500),
    description: z.string().default(""),
    status: statusZ.default("todo"),
    priority: priorityZ.default("none"),
    assignee_email: z.string().optional(),
    assignee_agent: z.string().max(50).optional().describe("Assign to an agent by name, e.g. 'Claude Code'"),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  },
  async ({ project_key, title, description, status, priority, assignee_email, assignee_agent, due_date }) => {
    const project = await projectByKey(project_key);
    const { data, error } = await supabase
      .from("issues")
      .insert({
        project_id: project.id,
        title,
        description,
        status,
        priority,
        due_date,
        assignee_id: assignee_email ? (await memberByEmail(assignee_email)).user_id : null,
        assignee_agent,
      })
      .select("number").single();
    if (error) fail(error.message);
    return json({ created: `${project.key}-${data.number}` });
  }
);

server.tool(
  "update_issue",
  "Update fields on an issue (status, priority, assignee, title, description, due date). Changes are logged to the activity trail attributed to this agent.",
  {
    ...issueIdArgs,
    title: z.string().min(1).max(500).optional(),
    description: z.string().optional(),
    status: statusZ.optional(),
    priority: priorityZ.optional(),
    assignee_email: z.string().nullable().optional(),
    assignee_agent: z.string().max(50).nullable().optional().describe("Assign to an agent by name; null to unassign"),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  },
  async ({ id, project_key, number, assignee_email, ...fields }) => {
    const { project, issue } = await issueFromArgs({ id, project_key, number });
    const patch: Record<string, unknown> = { ...fields };
    if (assignee_email !== undefined)
      patch.assignee_id = assignee_email === null ? null : (await memberByEmail(assignee_email)).user_id;
    const { error } = await supabase.from("issues").update(patch).eq("id", issue.id);
    if (error) fail(error.message);
    return json({ updated: `${project.key}-${issue.number}` });
  }
);

server.tool(
  "add_comment",
  "Add a comment to an issue, attributed to this agent.",
  { ...issueIdArgs, body: z.string().min(1) },
  async ({ id, project_key, number, body }) => {
    const { project, issue } = await issueFromArgs({ id, project_key, number });
    const { error } = await supabase
      .from("comments")
      .insert({ issue_id: issue.id, body });
    if (error) fail(error.message);
    return json({ commented: `${project.key}-${issue.number}` });
  }
);

server.tool(
  "list_labels",
  "List a project's labels",
  { project_key: z.string() },
  async ({ project_key }) => {
    const project = await projectByKey(project_key);
    const { data, error } = await supabase
      .from("labels").select("name, color").eq("project_id", project.id).order("name");
    if (error) fail(error.message);
    return json(data);
  }
);

server.tool(
  "set_issue_labels",
  "Replace an issue's labels with the given set. Unknown labels are created in the project automatically.",
  { ...issueIdArgs, labels: z.array(z.string().min(1).max(50)).max(20) },
  async ({ id, project_key, number, labels }) => {
    const { project, issue } = await issueFromArgs({ id, project_key, number });
    const names = [...new Set(labels)];
    if (names.length > 0) {
      const { error: upsertErr } = await supabase
        .from("labels")
        .upsert(names.map((name) => ({ project_id: project.id, name })), {
          onConflict: "project_id,name",
          ignoreDuplicates: true,
        });
      if (upsertErr) fail(upsertErr.message);
    }
    const { data: rows, error: fetchErr } = await supabase
      .from("labels").select("id, name").eq("project_id", project.id).in("name", names);
    if (fetchErr) fail(fetchErr.message);
    const { error: clearErr } = await supabase.from("issue_labels").delete().eq("issue_id", issue.id);
    if (clearErr) fail(clearErr.message);
    if ((rows ?? []).length > 0) {
      const { error: linkErr } = await supabase
        .from("issue_labels")
        .insert(rows!.map((l) => ({ issue_id: issue.id, label_id: l.id })));
      if (linkErr) fail(linkErr.message);
    }
    return json({ issue: `${project.key}-${issue.number}`, labels: (rows ?? []).map((l) => l.name) });
  }
);

const STATUS_QUEUE = ["in_progress", "todo", "backlog"] as const;
const PRIORITY_RANK: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };

server.tool(
  "next_task",
  "Get the next issue assigned to you (this agent) to work on: unfinished work first, then highest priority, then oldest. When you start, set its status to in_progress; when finished, call submit_for_review. Returns null when your queue is empty.",
  {},
  async () => {
    const { data, error } = await supabase
      .from("issues")
      .select("number, title, description, status, priority, due_date, needs_review, created_at, projects!inner(key)")
      .eq("assignee_agent", agentName)
      .eq("needs_review", false)
      .in("status", [...STATUS_QUEUE]);
    if (error) fail(error.message);
    const queue = (data ?? []).sort((a: any, b: any) =>
      STATUS_QUEUE.indexOf(a.status) - STATUS_QUEUE.indexOf(b.status) ||
      PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] ||
      a.created_at.localeCompare(b.created_at)
    );
    const next = queue[0] as any;
    return json(
      next
        ? {
            task: {
              id: `${next.projects.key}-${next.number}`,
              title: next.title,
              description: next.description,
              status: next.status,
              priority: next.priority,
              due_date: next.due_date,
            },
            remaining_in_queue: queue.length - 1,
          }
        : { task: null, remaining_in_queue: 0 }
    );
  }
);

server.tool(
  "submit_for_review",
  "Mark an issue as finished and awaiting human review (don't set status to done yourself — a human approves by moving it to done). Optionally add a summary comment of what you did.",
  { ...issueIdArgs, summary: z.string().min(1).max(65536).optional() },
  async ({ id, project_key, number, summary }) => {
    const { project, issue } = await issueFromArgs({ id, project_key, number });
    if (summary) {
      const { error } = await supabase.from("comments").insert({ issue_id: issue.id, body: summary });
      if (error) fail(error.message);
    }
    const { error } = await supabase.from("issues").update({ needs_review: true }).eq("id", issue.id);
    if (error) fail(error.message);
    return json({ submitted_for_review: `${project.key}-${issue.number}` });
  }
);

server.tool(
  "agent_activity",
  "Everything AI agents did in the workspace, newest first. Optionally since an ISO date.",
  { since: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
  async ({ since, limit }) => {
    let q = supabase
      .from("activity")
      .select("action, old_value, new_value, agent_name, actor_id, created_at, issues!inner(number, title, projects!inner(key, workspace_id))")
      .eq("issues.projects.workspace_id", workspaceId)
      .not("agent_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (since) q = q.gte("created_at", since);
    const [{ data, error }, names] = await Promise.all([q, memberNames()]);
    if (error) fail(error.message);
    return json(
      (data ?? []).map((a: any) => ({
        issue: `${a.issues.projects.key}-${a.issues.number}`,
        issue_title: a.issues.title,
        agent: a.agent_name,
        for: a.actor_id ? names.get(a.actor_id)?.display_name ?? null : null,
        action: a.action,
        from: a.old_value,
        to: a.new_value,
        at: a.created_at,
      }))
    );
  }
);

  return server;
}

/** Anon-key client that signs in as a member (stdio + legacy shared mode).
 *  Multi-tenant: KRIYA_WORKSPACE_SLUG picks which workspace this session
 *  operates in; the slug travels as an `x-workspace-slug` header so RLS
 *  scopes reads/writes to that workspace. Also resolves the workspace_id
 *  the caller must pass into createServer(). */
async function signedInClient(): Promise<{ client: SupabaseClient; workspaceId: string }> {
  const slug = env("KRIYA_WORKSPACE_SLUG");
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { "x-kriya-agent": AGENT, "x-workspace-slug": slug } },
  });
  const { error } = await client.auth.signInWithPassword({
    email: env("KRIYA_EMAIL"),
    password: env("KRIYA_PASSWORD"),
  });
  if (error) {
    console.error(`Kriya sign-in failed: ${error.message}`);
    process.exit(1);
  }
  const { data: wid, error: widErr } = await client.rpc("current_workspace_id");
  if (widErr || !wid) {
    console.error(`Not a member of workspace '${slug}' (or workspace doesn't exist)`);
    process.exit(1);
  }
  return { client, workspaceId: wid as string };
}

interface KeyIdentity {
  user_id: string;
  workspace_id: string;
  agent_name: string;
  display_name: string;
  email: string;
}

async function serveHttp(port: number) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const sharedToken = process.env.MCP_AUTH_TOKEN;
  if (!serviceKey && !sharedToken) {
    console.error("HTTP mode needs SUPABASE_SERVICE_ROLE_KEY (per-user agent keys) or MCP_AUTH_TOKEN (shared token)");
    process.exit(1);
  }

  // Legacy shared-token mode: one signed-in identity for every request.
  const shared = sharedToken ? await signedInClient() : null;
  const sharedClient = shared?.client ?? null;
  const sharedWorkspaceId = shared?.workspaceId ?? null;

  // Agent-key mode: resolve `kriya_...` bearer keys to member identities via
  // the service role; the database trusts x-kriya-actor only from us.
  const admin = serviceKey
    ? createClient(SUPABASE_URL, serviceKey, { auth: { persistSession: false } })
    : null;
  const keyCache = new Map<string, { identity: KeyIdentity; at: number }>();
  const KEY_CACHE_TTL_MS = 60_000;

  async function clientForKey(key: string): Promise<{ client: SupabaseClient; identity: KeyIdentity } | null> {
    if (!admin || !serviceKey) return null;
    const cached = keyCache.get(key);
    let identity = cached && Date.now() - cached.at < KEY_CACHE_TTL_MS ? cached.identity : null;
    if (!identity) {
      const { data, error } = await admin.rpc("resolve_agent_key", { key });
      if (error || !data) return null;
      identity = data as KeyIdentity;
      keyCache.set(key, { identity, at: Date.now() });
    }
    const client = createClient(SUPABASE_URL, serviceKey, {
      auth: { persistSession: false },
      global: { headers: { "x-kriya-agent": identity.agent_name, "x-kriya-actor": identity.user_id } },
    });
    return { client, identity };
  }

  const app = express();
  app.use(express.json());
  app.get("/healthz", (_req, res) => void res.status(200).send("ok"));
  app.post("/mcp", async (req, res) => {
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    let db: SupabaseClient | null = null;
    let agentName = AGENT;
    let workspaceId: string | null = null;
    if (sharedClient && sharedToken && bearer === sharedToken) {
      db = sharedClient;
      workspaceId = sharedWorkspaceId;
    } else if (bearer.startsWith("kriya_")) {
      const resolved = await clientForKey(bearer);
      db = resolved?.client ?? null;
      if (resolved) {
        agentName = resolved.identity.agent_name;
        workspaceId = resolved.identity.workspace_id;
      }
    }
    if (db && !workspaceId) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32002, message: "no workspace bound to this credential" }, id: null });
      return;
    }
    if (!db) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "unauthorized" },
        id: null,
      });
      return;
    }
    try {
      // Stateless mode: one transport + server instance per request.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => void transport.close());
      await createServer(db, agentName, workspaceId!).connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("request failed:", e);
      if (!res.headersSent) res.status(500).end();
    }
  });
  app.listen(port, () =>
    console.error(
      `Kriya MCP server (HTTP) listening on :${port} — ` +
        `${admin ? "per-user agent keys" : ""}${admin && sharedClient ? " + " : ""}${sharedClient ? `shared token as "${AGENT}"` : ""}`,
    ),
  );
}

async function main() {
  // Cloud Run (and most PaaS) set PORT — serve Streamable HTTP there.
  // Without PORT, run as a local stdio server (Claude Code, Claude Desktop).
  const port = process.env.PORT;
  if (port) {
    await serveHttp(Number(port));
  } else {
    const { client, workspaceId } = await signedInClient();
    await createServer(client, AGENT, workspaceId).connect(new StdioServerTransport());
    console.error(`Kriya MCP server running as agent "${AGENT}"`);
  }
}

main();
