#!/usr/bin/env node
/**
 * Kriya MCP server. Signs in as a real Kriya member (RLS applies — the agent
 * can do exactly what its human can). Attribution rides on the x-kriya-agent
 * request header: Postgres triggers stamp it onto every write server-side, so
 * the activity log shows "Claude Code (for <member>)" and this process never
 * touches attribution columns directly.
 *
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, KRIYA_EMAIL, KRIYA_PASSWORD,
 *      KRIYA_AGENT_NAME (optional, default "Claude Code")
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

const supabase: SupabaseClient = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
  global: { headers: { "x-kriya-agent": AGENT } },
});

const STATUSES = ["backlog", "todo", "in_progress", "done", "cancelled"] as const;
const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

const statusZ = z.enum(STATUSES);
const priorityZ = z.enum(PRIORITIES);

function fail(msg: string): never {
  throw new Error(msg);
}

async function projectByKey(key: string) {
  const { data, error } = await supabase.from("projects").select("*").eq("key", key.toUpperCase()).single();
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

async function memberByEmail(email: string) {
  const { data, error } = await supabase.from("members").select("*").eq("email", email).single();
  if (error || !data) fail(`No member with email '${email}'`);
  return data;
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// PostgREST or() filters treat commas/parens as syntax; strip them from user input.
function likePattern(search: string): string {
  return `%${search.replace(/[,()]/g, " ").trim()}%`;
}

function createServer(): McpServer {
  const server = new McpServer({ name: "kriya", version: "0.1.0" });

server.tool("list_projects", "List all projects in the workspace", {}, async () => {
  const { data, error } = await supabase.from("projects").select("key, name, color, created_at").order("name");
  if (error) fail(error.message);
  return json(data);
});

server.tool(
  "create_project",
  "Create a new project. Key is a short uppercase code like PAY or WEB.",
  { key: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,7}$/), name: z.string().min(1), color: z.string().optional() },
  async ({ key, name, color }) => {
    const { data: me } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("projects")
      .insert({ key: key.toUpperCase(), name, color, created_by: me.user?.id })
      .select().single();
    if (error) fail(error.message);
    return json(data);
  }
);

server.tool("list_members", "List workspace members (for assigning issues)", {}, async () => {
  const { data, error } = await supabase.from("members").select("display_name, email").order("display_name");
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
    search: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ project_key, status, priority, assignee_email, search, limit }) => {
    let q = supabase
      .from("issues")
      .select("number, title, status, priority, due_date, created_by_agent, created_at, projects!inner(key), assignee:members!issues_assignee_id_fkey(display_name, email)")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (project_key) q = q.eq("projects.key", project_key.toUpperCase());
    if (status) q = q.eq("status", status);
    if (priority) q = q.eq("priority", priority);
    if (assignee_email) q = q.eq("assignee_id", (await memberByEmail(assignee_email)).user_id);
    if (search) {
      const p = likePattern(search);
      q = q.or(`title.ilike.${p},description.ilike.${p}`);
    }
    const { data, error } = await q;
    if (error) fail(error.message);
    return json(
      (data ?? []).map((i: any) => ({
        id: `${i.projects.key}-${i.number}`,
        title: i.title,
        status: i.status,
        priority: i.priority,
        assignee: i.assignee?.display_name ?? null,
        due_date: i.due_date,
        created_by_agent: i.created_by_agent,
      }))
    );
  }
);

server.tool(
  "get_issue",
  "Get one issue with its comments and full activity history. id like 'PAY-42'.",
  { project_key: z.string(), number: z.number().int() },
  async ({ project_key, number }) => {
    const { project, issue } = await issueRef(project_key, number);
    const [{ data: comments }, { data: activity }, { data: labels }] = await Promise.all([
      supabase.from("comments")
        .select("body, agent_name, created_at, author:members!comments_author_id_fkey(display_name)")
        .eq("issue_id", issue.id).order("created_at"),
      supabase.from("activity")
        .select("action, old_value, new_value, agent_name, created_at, actor:members!activity_actor_id_fkey(display_name)")
        .eq("issue_id", issue.id).order("created_at"),
      supabase.from("issue_labels").select("label:labels(name, color)").eq("issue_id", issue.id),
    ]);
    return json({
      id: `${project.key}-${issue.number}`,
      ...issue,
      labels: (labels ?? []).map((l: any) => l.label?.name),
      comments,
      activity,
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
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  },
  async ({ project_key, title, description, status, priority, assignee_email, due_date }) => {
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
    project_key: z.string(),
    number: z.number().int(),
    title: z.string().min(1).max(500).optional(),
    description: z.string().optional(),
    status: statusZ.optional(),
    priority: priorityZ.optional(),
    assignee_email: z.string().nullable().optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  },
  async ({ project_key, number, assignee_email, ...fields }) => {
    const { project, issue } = await issueRef(project_key, number);
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
  { project_key: z.string(), number: z.number().int(), body: z.string().min(1) },
  async ({ project_key, number, body }) => {
    const { project, issue } = await issueRef(project_key, number);
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
  { project_key: z.string(), number: z.number().int(), labels: z.array(z.string().min(1).max(50)).max(20) },
  async ({ project_key, number, labels }) => {
    const { project, issue } = await issueRef(project_key, number);
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

server.tool(
  "agent_activity",
  "Everything AI agents did in the workspace, newest first. Optionally since an ISO date.",
  { since: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) },
  async ({ since, limit }) => {
    let q = supabase
      .from("activity")
      .select("action, old_value, new_value, agent_name, created_at, actor:members!activity_actor_id_fkey(display_name), issues!inner(number, title, projects!inner(key))")
      .not("agent_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (since) q = q.gte("created_at", since);
    const { data, error } = await q;
    if (error) fail(error.message);
    return json(
      (data ?? []).map((a: any) => ({
        issue: `${a.issues.projects.key}-${a.issues.number}`,
        issue_title: a.issues.title,
        agent: a.agent_name,
        for: a.actor?.display_name ?? null,
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

async function main() {
  const { error } = await supabase.auth.signInWithPassword({
    email: env("KRIYA_EMAIL"),
    password: env("KRIYA_PASSWORD"),
  });
  if (error) {
    console.error(`Kriya sign-in failed: ${error.message}`);
    process.exit(1);
  }

  // Cloud Run (and most PaaS) set PORT — serve Streamable HTTP there.
  // Without PORT, run as a local stdio server (Claude Code, Claude Desktop).
  const port = process.env.PORT;
  if (port) {
    const token = env("MCP_AUTH_TOKEN");
    const app = express();
    app.use(express.json());
    app.get("/healthz", (_req, res) => void res.status(200).send("ok"));
    app.post("/mcp", async (req, res) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
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
        await createServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (e) {
        console.error("request failed:", e);
        if (!res.headersSent) res.status(500).end();
      }
    });
    app.listen(Number(port), () =>
      console.error(`Kriya MCP server (HTTP) listening on :${port} as agent "${AGENT}"`),
    );
  } else {
    await createServer().connect(new StdioServerTransport());
    console.error(`Kriya MCP server running as agent "${AGENT}"`);
  }
}

main();
