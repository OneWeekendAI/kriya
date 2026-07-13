// deno test --allow-env --allow-net test.ts
// Covers everything reachable without a live database: ref parsing, HMAC
// verification, and the handler's gate conditions (signature, event type,
// action filter, no-refs short-circuit).
import { assertEquals } from "jsr:@std/assert@1";
import { extractRefs, handler, verifySignature } from "./index.ts";

const SECRET = "test-secret";
Deno.env.set("GITHUB_WEBHOOK_SECRET", SECRET);

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function request(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost/github-webhook", { method: "POST", body, headers });
}

Deno.test("extractRefs finds ids in titles and branch names, deduped, case-insensitive", () => {
  assertEquals(
    extractRefs("KRI-42: fix auth leak (also KRI-42, E2E-7)", "kri-42-fix-auth-leak"),
    [{ key: "KRI", number: 42 }, { key: "E2E", number: 7 }],
  );
  assertEquals(extractRefs("no refs here", undefined), []);
});

Deno.test("verifySignature accepts a valid signature and rejects forgeries", async () => {
  const body = '{"a":1}';
  assertEquals(await verifySignature(SECRET, body, await sign(body)), true);
  assertEquals(await verifySignature(SECRET, body, await sign(body + "x")), false);
  assertEquals(await verifySignature(SECRET, body, "sha256=deadbeef"), false);
  assertEquals(await verifySignature(SECRET, body, null), false);
});

Deno.test("handler rejects a bad signature with 401", async () => {
  const res = await handler(request("{}", { "x-hub-signature-256": "sha256=00" }));
  assertEquals(res.status, 401);
});

Deno.test("handler ignores non-pull_request events", async () => {
  const body = "{}";
  const res = await handler(request(body, {
    "x-hub-signature-256": await sign(body),
    "x-github-event": "push",
  }));
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ignored event");
});

Deno.test("handler ignores irrelevant PR actions", async () => {
  const body = JSON.stringify({ action: "synchronize", pull_request: { title: "KRI-1" } });
  const res = await handler(request(body, {
    "x-hub-signature-256": await sign(body),
    "x-github-event": "pull_request",
  }));
  assertEquals(await res.text(), "ignored action");
});

Deno.test("handler short-circuits when the PR mentions no issues", async () => {
  const body = JSON.stringify({
    action: "opened",
    pull_request: { title: "chore: bump deps", head: { ref: "chore/bump-deps" }, html_url: "x" },
  });
  const res = await handler(request(body, {
    "x-hub-signature-256": await sign(body),
    "x-github-event": "pull_request",
  }));
  assertEquals(await res.text(), "no issue refs");
});
