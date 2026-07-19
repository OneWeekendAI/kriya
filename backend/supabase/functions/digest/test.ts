// deno test backend/supabase/functions/digest/test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeActivity, groupLines, renderHtml, renderText, toLines } from "./index.ts";

const issue = (n: number, title: string) => ({ number: n, title, projects: { key: "KRI" } });

const activity = [
  { action: "created", old_value: null, new_value: "Fix auth", agent_name: "Claude Code",
    created_at: "2026-07-19T05:00:00Z", actor: { display_name: "Ritwik" }, issues: issue(1, "Fix auth") },
  { action: "status", old_value: "todo", new_value: "in_progress", agent_name: "Claude Code",
    created_at: "2026-07-19T05:01:00Z", actor: { display_name: "Ritwik" }, issues: issue(1, "Fix auth") },
  { action: "review", old_value: null, new_value: "requested", agent_name: "Claude Code",
    created_at: "2026-07-19T06:00:00Z", actor: { display_name: "Ritwik" }, issues: issue(1, "Fix auth") },
  { action: "status", old_value: "in_progress", new_value: "done", agent_name: "GitHub",
    created_at: "2026-07-19T07:00:00Z", actor: null, issues: issue(2, "Webhook <tag>") },
];

const comments = [
  { body: "Shipped in PR #7", agent_name: "Claude Code", created_at: "2026-07-19T05:30:00Z",
    author: { display_name: "Ritwik" }, issues: issue(1, "Fix auth") },
];

Deno.test("describeActivity covers the queue actions", () => {
  assertEquals(describeActivity({ action: "review", old_value: null, new_value: "requested" }),
    "submitted it for review");
  assertEquals(describeActivity({ action: "agent_assignee", old_value: null, new_value: "Claude Code" }),
    "assigned agent Claude Code");
  assertEquals(describeActivity({ action: "status", old_value: "todo", new_value: "done" }),
    "moved it todo → done");
});

Deno.test("toLines merges and time-orders activity and comments", () => {
  const lines = toLines(activity as never, comments as never);
  assertEquals(lines.length, 5);
  assertEquals(lines.map((l) => l.at), [...lines.map((l) => l.at)].sort());
  assert(lines.some((l) => l.what.includes("Shipped in PR #7")));
});

Deno.test("groupLines nests agent → issue", () => {
  const g = groupLines(toLines(activity as never, comments as never));
  assertEquals([...g.keys()], ["Claude Code", "GitHub"]);
  assertEquals(g.get("Claude Code")!.get("KRI-1")!.length, 4);
  assertEquals(g.get("GitHub")!.get("KRI-2")!.length, 1);
});

Deno.test("renderHtml escapes content and carries the summary", () => {
  const lines = toLines(activity as never, comments as never);
  const html = renderHtml(lines, "Saturday 19 July");
  assert(html.includes("Webhook &lt;tag&gt;"), "titles are escaped");
  assert(!html.includes("Webhook <tag>"), "no raw html injection");
  assert(html.includes("5 entries across 2 issues"), "summary line");
  assert(html.includes("for Ritwik"), "attribution shown");
});

Deno.test("renderText is a readable fallback", () => {
  const text = renderText(toLines(activity as never, comments as never), "Saturday 19 July");
  assert(text.includes("Claude Code\n"));
  assert(text.includes("  KRI-1 Fix auth"));
  assert(text.includes("    - submitted it for review"));
});
