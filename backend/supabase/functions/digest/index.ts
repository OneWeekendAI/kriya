// Agent daily digest (Supabase Edge Function).
//
// Once a day, every member gets one email: what the AI agents did in the
// workspace since yesterday — grouped per agent, then per issue. If the
// agents were quiet, no email is sent.
//
// Setup (dashboard only, no CLI needed):
//   1. Edge Functions → Deploy new function → name: digest → paste this file.
//      Turn "Verify JWT" OFF — the cron caller authenticates with a secret.
//   2. Edge Functions → digest → Secrets:
//        DIGEST_SECRET = any long random string
//        SMTP_HOST     = e.g. smtp.gmail.com
//        SMTP_PORT     = 465
//        SMTP_USER     = you@gmail.com
//        SMTP_PASS     = app password
//        SMTP_FROM     = optional, defaults to SMTP_USER
//   3. Schedule it (SQL editor; pg_cron + pg_net ship with hosted Supabase).
//      08:30 IST = 03:00 UTC:
//        select cron.schedule('kriya-digest', '0 3 * * *', $$
//          select net.http_post(
//            url     := 'https://<project-ref>.supabase.co/functions/v1/digest',
//            headers := '{"x-digest-secret": "<DIGEST_SECRET>"}'::jsonb
//          )
//        $$);
//
// POST body (all optional): { "hours": 24, "dry_run": true }
// dry_run returns the rendered email instead of sending it.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// ---------------------------------------------------------------------------
// Pure composition helpers (unit-tested in ./test.ts)
// ---------------------------------------------------------------------------

export interface Line {
  issue: string; // "KRI-42"
  issue_title: string;
  agent: string;
  for_name: string | null;
  what: string; // human sentence
  at: string; // ISO
}

interface ActivityRow {
  action: string;
  old_value: string | null;
  new_value: string | null;
  agent_name: string;
  created_at: string;
  actor: { display_name: string } | null;
  issues: { number: number; title: string; projects: { key: string } };
}

interface CommentRow {
  body: string;
  agent_name: string;
  created_at: string;
  author: { display_name: string } | null;
  issues: { number: number; title: string; projects: { key: string } };
}

export function describeActivity(a: { action: string; old_value: string | null; new_value: string | null }): string {
  switch (a.action) {
    case "created": return "opened it";
    case "status": return `moved it ${a.old_value} → ${a.new_value}`;
    case "review": return a.new_value === "requested" ? "submitted it for review" : "cleared its review flag";
    case "agent_assignee": return a.new_value ? `assigned agent ${a.new_value}` : "unassigned its agent";
    case "priority": return `set priority ${a.old_value ?? "—"} → ${a.new_value}`;
    case "title": return "retitled it";
    case "due_date": return a.new_value ? `set the due date to ${a.new_value}` : "removed the due date";
    case "assignee": return "changed the assignee";
    default: return `${a.action}: ${a.old_value ?? "—"} → ${a.new_value ?? "—"}`;
  }
}

export function toLines(activity: ActivityRow[], comments: CommentRow[]): Line[] {
  const clip = (s: string) => (s.length > 140 ? s.slice(0, 139) + "…" : s);
  return [
    ...activity.map((a) => ({
      issue: `${a.issues.projects.key}-${a.issues.number}`,
      issue_title: a.issues.title,
      agent: a.agent_name,
      for_name: a.actor?.display_name ?? null,
      what: describeActivity(a),
      at: a.created_at,
    })),
    ...comments.map((c) => ({
      issue: `${c.issues.projects.key}-${c.issues.number}`,
      issue_title: c.issues.title,
      agent: c.agent_name,
      for_name: c.author?.display_name ?? null,
      what: `wrote: “${clip(c.body)}”`,
      at: c.created_at,
    })),
  ].sort((x, y) => x.at.localeCompare(y.at));
}

/** agent → issue → lines, preserving time order. */
export function groupLines(lines: Line[]): Map<string, Map<string, Line[]>> {
  const byAgent = new Map<string, Map<string, Line[]>>();
  for (const l of lines) {
    const issues = byAgent.get(l.agent) ?? new Map<string, Line[]>();
    const list = issues.get(l.issue) ?? [];
    list.push(l);
    issues.set(l.issue, list);
    byAgent.set(l.agent, issues);
  }
  return byAgent;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderHtml(lines: Line[], dateLabel: string): string {
  const grouped = groupLines(lines);
  const issueCount = new Set(lines.map((l) => l.issue)).size;
  const sections = [...grouped.entries()].map(([agent, issues]) => {
    const blocks = [...issues.entries()].map(([id, ls]) => {
      const items = ls.map((l) => `<li>${esc(l.what)}</li>`).join("");
      return `<p style="margin:14px 0 4px"><span style="font-family:monospace;color:#d85a30">${esc(id)}</span>
        <span style="color:#3d3733">${esc(ls[0].issue_title)}</span></p>
        <ul style="margin:0 0 0 18px;padding:0;color:#6b635c">${items}</ul>`;
    }).join("");
    const forName = issues.values().next().value?.[0]?.for_name;
    return `<h2 style="font-size:15px;margin:26px 0 2px;color:#1f1b18">${esc(agent)}
      ${forName ? `<span style="font-weight:normal;color:#9b9187"> for ${esc(forName)}</span>` : ""}</h2>
      <div style="border-top:1px solid #e4dcd2">${blocks}</div>`;
  }).join("");
  return `<!doctype html><html><body style="margin:0;background:#faf6ef;padding:32px 12px">
  <div style="max-width:560px;margin:0 auto;font-family:Georgia,serif;color:#1f1b18">
    <p style="font-family:monospace;font-size:11px;letter-spacing:.12em;color:#9b9187;margin:0">KRIYA · AGENT DIGEST</p>
    <h1 style="font-size:22px;margin:6px 0 2px">${esc(dateLabel)}</h1>
    <p style="color:#6b635c;margin:0 0 8px">${lines.length} ${lines.length === 1 ? "entry" : "entries"} across ${issueCount} ${issueCount === 1 ? "issue" : "issues"}, signed by ${grouped.size} ${grouped.size === 1 ? "agent" : "agents"}.</p>
    ${sections}
    <p style="font-family:monospace;font-size:11px;color:#9b9187;margin-top:34px">— sent by your Kriya workspace</p>
  </div></body></html>`;
}

export function renderText(lines: Line[], dateLabel: string): string {
  const grouped = groupLines(lines);
  let out = `KRIYA — AGENT DIGEST — ${dateLabel}\n`;
  for (const [agent, issues] of grouped) {
    out += `\n${agent}\n`;
    for (const [id, ls] of issues) {
      out += `  ${id} ${ls[0].issue_title}\n`;
      for (const l of ls) out += `    - ${l.what}\n`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const secret = Deno.env.get("DIGEST_SECRET");
  if (!secret || req.headers.get("x-digest-secret") !== secret) {
    return json(401, { error: "bad or missing x-digest-secret" });
  }

  let body: { hours?: number; dry_run?: boolean } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const hours = Math.min(Math.max(body.hours ?? 24, 1), 24 * 7);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const issueSel = "issues!inner(number, title, projects!inner(key))";
  const [{ data: activity, error: aErr }, { data: comments, error: cErr }, { data: members, error: mErr }] =
    await Promise.all([
      admin.from("activity")
        .select(`action, old_value, new_value, agent_name, created_at, actor:members!activity_actor_id_fkey(display_name), ${issueSel}`)
        .not("agent_name", "is", null).gte("created_at", since).order("created_at"),
      admin.from("comments")
        .select(`body, agent_name, created_at, author:members!comments_author_id_fkey(display_name), ${issueSel}`)
        .not("agent_name", "is", null).gte("created_at", since).order("created_at"),
      admin.from("members").select("email, display_name"),
    ]);
  if (aErr || cErr || mErr) return json(500, { error: (aErr ?? cErr ?? mErr)!.message });

  const lines = toLines((activity ?? []) as never, (comments ?? []) as never);
  const dateLabel = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  if (lines.length === 0) return json(200, { sent: false, reason: "agents were quiet" });

  const html = renderHtml(lines, dateLabel);
  const text = renderText(lines, dateLabel);
  const subject = `Kriya agent digest — ${lines.length} ${lines.length === 1 ? "entry" : "entries"} · ${dateLabel}`;
  if (body.dry_run) return json(200, { sent: false, dry_run: true, subject, entries: lines.length, html, text });

  const host = Deno.env.get("SMTP_HOST");
  const user = Deno.env.get("SMTP_USER");
  const pass = Deno.env.get("SMTP_PASS");
  if (!host || !user || !pass) return json(500, { error: "SMTP_HOST/SMTP_USER/SMTP_PASS not configured" });

  const client = new SMTPClient({
    connection: {
      hostname: host,
      port: Number(Deno.env.get("SMTP_PORT") ?? 465),
      tls: true,
      auth: { username: user, password: pass },
    },
  });
  const from = Deno.env.get("SMTP_FROM") ?? user;
  const to = (members ?? []).map((m) => m.email);
  try {
    for (const rcpt of to) {
      await client.send({ from: `Kriya <${from}>`, to: rcpt, subject, content: text, html });
    }
  } finally {
    await client.close();
  }
  return json(200, { sent: true, recipients: to.length, entries: lines.length });
}

if (import.meta.main) Deno.serve(handler);
