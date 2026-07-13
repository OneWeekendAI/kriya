// End-to-end test against a real Supabase project. Exercises both write paths:
//   1. the app path (plain supabase-js, no agent header) — human attribution
//   2. the MCP path (spawns the built server, drives it as an MCP client) — agent attribution
// and asserts the attribution boundary between them.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, KRIYA_EMAIL, KRIYA_PASSWORD
// Usage: node test/e2e.mjs   (run `npm run build` first)
import { createClient } from "@supabase/supabase-js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const { SUPABASE_URL, SUPABASE_ANON_KEY, KRIYA_EMAIL, KRIYA_PASSWORD } = process.env;
for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "KRIYA_EMAIL", "KRIYA_PASSWORD"])
  if (!process.env[k]) { console.error(`Missing ${k}`); process.exit(1); }

const AGENT = "E2E Agent";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

// ---------- 1. Auth: sign in, or sign up on first run ----------
console.log("auth…");
let { data: session, error } = await supabase.auth.signInWithPassword({
  email: KRIYA_EMAIL, password: KRIYA_PASSWORD,
});
if (error) {
  const { data, error: upErr } = await supabase.auth.signUp({
    email: KRIYA_EMAIL, password: KRIYA_PASSWORD, options: { data: { name: "Ritwik" } },
  });
  if (upErr) { console.error(`Sign-up failed: ${upErr.message}`); process.exit(1); }
  if (!data.session) {
    console.error(`Signed up, but email confirmation is required. Confirm ${KRIYA_EMAIL}, then re-run.`);
    process.exit(2);
  }
  session = data;
}
const uid = session.user.id;
ok(`signed in as ${KRIYA_EMAIL}`);

const { data: me } = await supabase.from("members").select("*").eq("user_id", uid).single();
assert(me, "bootstrap trigger enrolled the first user as a member");
ok(`member row exists (${me.display_name})`);

// ---------- 2. App path: human writes, no agent attribution ----------
console.log("app path (human)…");
const key = "E2E";
let { data: project } = await supabase.from("projects").select("*").eq("key", key).single();
if (!project) {
  ({ data: project } = await supabase
    .from("projects").insert({ key, name: "E2E Test" }).select().single());
}
assert(project, "project exists");
ok(`project ${project.key}`);

const { data: humanIssue, error: hiErr } = await supabase
  .from("issues")
  .insert({ project_id: project.id, title: "Human-created issue", created_by: crypto.randomUUID() /* spoof attempt */ })
  .select().single();
assert(!hiErr, `human issue created: ${hiErr?.message}`);
assert.equal(humanIssue.created_by, uid, "created_by is auth.uid(), spoof ignored");
assert.equal(humanIssue.created_by_agent, null, "no agent attribution on app writes");
ok(`issue ${key}-${humanIssue.number} created, spoof-proof, human-attributed`);

await supabase.from("issues").update({ status: "in_progress" }).eq("id", humanIssue.id);
const { data: humanAct } = await supabase
  .from("activity").select("*").eq("issue_id", humanIssue.id).order("id");
assert(humanAct.length >= 2, "created + status activity logged");
assert(humanAct.every((a) => a.agent_name === null), "human activity carries no agent name");
ok("activity trail logged, human-attributed");

const { error: forgeErr } = await supabase
  .from("activity").insert({ issue_id: humanIssue.id, action: "forged" });
assert(forgeErr, "client cannot write to the activity trail");
ok("activity trail is client-immutable");

// ---------- 3. MCP path: drive the real server as a client ----------
console.log("mcp path (agent)…");
const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../dist/index.js", import.meta.url).pathname],
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "PORT")),
    SUPABASE_URL, SUPABASE_ANON_KEY,
    KRIYA_EMAIL, KRIYA_PASSWORD,
    KRIYA_AGENT_NAME: AGENT,
  },
});
const mcp = new Client({ name: "kriya-e2e", version: "0.0.0" });
await mcp.connect(transport);

const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
assert(tools.includes("create_issue") && tools.includes("agent_activity"), "tools registered");
ok(`server exposes ${tools.length} tools`);

const call = async (name, args) => {
  const res = await mcp.callTool({ name, arguments: args });
  assert(!res.isError, `${name} failed: ${JSON.stringify(res.content)}`);
  return JSON.parse(res.content[0].text);
};

const created = await call("create_issue", {
  project_key: key, title: "Agent-created issue", priority: "high",
});
const agentNumber = Number(created.created.split("-")[1]);
ok(`agent created ${created.created}`);

await call("update_issue", { project_key: key, number: agentNumber, status: "in_progress" });
await call("add_comment", { project_key: key, number: agentNumber, body: "Working on it." });
await call("set_issue_labels", { project_key: key, number: agentNumber, labels: ["bug", "auth"] });
ok("agent updated status, commented, set labels");

const issue = await call("get_issue", { project_key: key, number: agentNumber });
assert.equal(issue.created_by_agent, AGENT, "issue attributed to the agent");
assert.equal(issue.created_by, uid, "…acting for the signed-in human");
assert.deepEqual(issue.labels.sort(), ["auth", "bug"], "labels set");
assert(issue.comments.some((c) => c.agent_name === AGENT), "comment attributed to the agent");
assert(issue.activity.some((a) => a.action === "status" && a.agent_name === AGENT),
  "status change attributed to the agent");
ok("full attribution: issue, comment, and activity all credit the agent + human");

const feed = await call("agent_activity", { limit: 20 });
assert(feed.some((f) => f.issue === `${key}-${agentNumber}` && f.agent === AGENT),
  "agent feed shows the agent's work");
assert(!feed.some((f) => f.issue === `${key}-${humanIssue.number}`),
  "agent feed excludes purely human work");
ok("agent_activity feed correct");

// ---------- 4. The leak test, live: human edits the agent's issue ----------
const { error: leakErr } = await supabase
  .from("issues").update({ priority: "urgent" })
  .eq("project_id", project.id).eq("number", agentNumber);
assert(!leakErr, `human update failed: ${leakErr?.message}`);
const after = await call("get_issue", { project_key: key, number: agentNumber });
const prioChange = after.activity.find((a) => a.action === "priority");
assert.equal(prioChange.agent_name, null, "human edit on agent issue carries NO agent name");
assert.equal(after.created_by_agent, AGENT, "created_by_agent survives the human edit");
ok("no attribution leak between agent and human writes");

await mcp.close();
console.log(`\nALL ${passed} E2E CHECKS PASSED`);
process.exit(0);
