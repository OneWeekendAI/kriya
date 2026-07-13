// GitHub → Kriya webhook (Supabase Edge Function).
//
// Mention an issue id like KRI-42 in a PR title or branch name and Kriya
// keeps the issue in sync: PR opened → In Progress, PR merged → Done, with
// a comment linking the PR either way. Inbound-only — Kriya never calls
// GitHub. Attribution rides the same x-kriya-agent header as the MCP
// server, so the activity log shows these changes as agent "GitHub".
//
// Setup (dashboard only, no CLI needed):
//   1. Edge Functions → Deploy new function → name: github-webhook → paste this file.
//   2. Edge Functions → github-webhook → Details -> turn OFF "Verify JWT".
//   3. Project Settings → Edge Functions → add secret GITHUB_WEBHOOK_SECRET=<random string>.
//   4. GitHub repo → Settings → Webhooks → add:
//        URL: https://<project>.supabase.co/functions/v1/github-webhook
//        Content type: application/json, Secret: same string,
//        Events: "Pull requests" only.
import { createClient } from "npm:@supabase/supabase-js@2";

const ISSUE_REF = /([A-Z][A-Z0-9]{1,7})-(\d+)/g;

export function extractRefs(...texts: (string | undefined)[]): { key: string; number: number }[] {
  const seen = new Set<string>();
  const refs: { key: string; number: number }[] = [];
  for (const text of texts) {
    for (const m of (text ?? "").toUpperCase().matchAll(ISSUE_REF)) {
      const id = `${m[1]}-${m[2]}`;
      if (!seen.has(id)) {
        seen.add(id);
        refs.push({ key: m[1], number: Number(m[2]) });
      }
    }
  }
  return refs;
}

export async function verifySignature(secret: string, body: string, signature: string | null): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time compare.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function handler(req: Request): Promise<Response> {
  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");
  if (!secret) return new Response("GITHUB_WEBHOOK_SECRET not configured", { status: 500 });

  const body = await req.text();
  if (!(await verifySignature(secret, body, req.headers.get("x-hub-signature-256")))) {
    return new Response("invalid signature", { status: 401 });
  }
  if (req.headers.get("x-github-event") !== "pull_request") {
    return new Response("ignored event", { status: 200 });
  }

  const payload = JSON.parse(body);
  const action: string = payload.action;
  const pr = payload.pull_request;
  if (!pr || !["opened", "reopened", "closed"].includes(action)) {
    return new Response("ignored action", { status: 200 });
  }

  const refs = extractRefs(pr.title, pr.head?.ref);
  if (refs.length === 0) return new Response("no issue refs", { status: 200 });

  // Service role (RLS bypass) is required because GitHub isn't a member;
  // the x-kriya-agent header still attributes every change to "GitHub".
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { global: { headers: { "x-kriya-agent": "GitHub" } } },
  );

  const results: string[] = [];
  for (const ref of refs) {
    const { data: issue } = await supabase
      .from("issues")
      .select("id, status, projects!inner(key)")
      .eq("projects.key", ref.key)
      .eq("number", ref.number)
      .single();
    if (!issue) {
      results.push(`${ref.key}-${ref.number}: not found`);
      continue;
    }

    let comment: string;
    if (action === "closed" && pr.merged) {
      if (issue.status !== "done" && issue.status !== "cancelled") {
        await supabase.from("issues").update({ status: "done" }).eq("id", issue.id);
      }
      comment = `PR merged: ${pr.html_url}`;
    } else if (action === "closed") {
      comment = `PR closed without merging: ${pr.html_url}`;
    } else {
      if (issue.status === "backlog" || issue.status === "todo") {
        await supabase.from("issues").update({ status: "in_progress" }).eq("id", issue.id);
      }
      comment = `PR ${action}: ${pr.html_url} — ${pr.title}`;
    }
    await supabase.from("comments").insert({ issue_id: issue.id, body: comment });
    results.push(`${ref.key}-${ref.number}: ok`);
  }

  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

if (import.meta.main) Deno.serve(handler);
