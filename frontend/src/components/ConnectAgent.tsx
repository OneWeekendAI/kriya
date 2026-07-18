import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { AgentKey } from "../lib/types";

const MCP_URL_KEY = "kriya.mcpUrl";

/**
 * "Connect your agent" — every member mints personal agent keys here and
 * copies ready-made client config. One remote MCP deployment serves the whole
 * team; keys carry identity, so attribution reads "Claude Code (for <you>)".
 */
export function ConnectAgent() {
  const [keys, setKeys] = useState<AgentKey[]>([]);
  const [agentName, setAgentName] = useState("Claude Code");
  const [minted, setMinted] = useState<{ agent_name: string; key: string } | null>(null);
  const [mcpUrl, setMcpUrl] = useState(
    localStorage.getItem(MCP_URL_KEY) ?? import.meta.env.VITE_KRIYA_MCP_URL ?? "",
  );
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.listAgentKeys().then(setKeys).catch((e) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, []);

  async function mint(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createAgentKey(agentName.trim() || "Claude Code");
      setMinted(created);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Two-click confirm — window.confirm() is a no-op in Tauri's webview.
  async function revoke(id: string) {
    setConfirmRevoke(null);
    await api.revokeAgentKey(id);
    if (minted) setMinted(null);
    await refresh();
  }

  function saveMcpUrl(url: string) {
    setMcpUrl(url);
    localStorage.setItem(MCP_URL_KEY, url);
  }

  const url = (mcpUrl.trim() || "https://<your-kriya-mcp-deployment>/mcp").replace(/\/+$/, "");
  const key = minted?.key ?? "kriya_<your key>";
  const claudeCodeSnippet = `claude mcp add --transport http kriya ${url} \\\n  --header "Authorization: Bearer ${key}"`;
  const otherClientSnippet = JSON.stringify(
    { url, headers: { Authorization: `Bearer ${key}` } },
    null,
    2,
  );

  return (
    <div className="page">
      <p>
        Mint a personal key for each agent you use. Keys act as <em>you</em> — every action shows
        up as "{minted?.agent_name ?? "Claude Code"} (for you)" in the ledger. The key is
        shown once; revoke it here any time.
      </p>

      <form onSubmit={mint} className="row" style={{ marginTop: 14 }}>
        <input
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="Agent name (shown in the ledger)"
          maxLength={50}
        />
        <button type="submit" className="btn-primary">Create key</button>
      </form>
      {error && <p className="error">{error}</p>}

      {minted && (
        <div className="minted">
          <p>
            Key for <strong>{minted.agent_name}</strong> — copy it now, it won't be shown again:
          </p>
          <pre>
            <code>{minted.key}</code>
          </pre>
          <button onClick={() => navigator.clipboard.writeText(minted.key)}>Copy key</button>
        </div>
      )}

      <section>
        <span className="overline">Your keys</span>
        <ul className="ruled-list">
          {keys.map((k) => (
            <li key={k.id}>
              <span className="grow">
                <code className="mono">{k.key_prefix}…</code> {k.agent_name}
                <span className="muted">
                  {" "}· created {new Date(k.created_at).toLocaleDateString()} ·{" "}
                  {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : "never used"}
                </span>
                {confirmRevoke === k.id && (
                  <span className="muted"> — agents using it stop working immediately.</span>
                )}
              </span>
              {confirmRevoke === k.id ? (
                <>
                  <button className="link" onClick={() => revoke(k.id)}>confirm revoke</button>
                  <button className="link" onClick={() => setConfirmRevoke(null)}>keep</button>
                </>
              ) : (
                <button className="link" onClick={() => setConfirmRevoke(k.id)}>revoke</button>
              )}
            </li>
          ))}
          {keys.length === 0 && <li className="muted">No keys yet.</li>}
        </ul>
      </section>

      <section>
        <span className="overline">Team MCP server</span>
        <p>Your team's deployed Kriya MCP URL (ask whoever deployed it):</p>
        <input
          style={{ width: "100%" }}
          value={mcpUrl}
          onChange={(e) => saveMcpUrl(e.target.value)}
          placeholder="https://kriya-mcp-xyz.a.run.app"
        />
      </section>

      <section>
        <span className="overline">Connect Claude Code</span>
        <div className="snippet-wrap">
          <pre className="snippet">
            <code>{claudeCodeSnippet}</code>
          </pre>
          <button
            className="snippet-copy"
            onClick={() => navigator.clipboard.writeText(claudeCodeSnippet)}
          >
            Copy
          </button>
        </div>
      </section>

      <section>
        <span className="overline">Any other MCP client</span>
        <div className="snippet-wrap">
          <pre className="snippet">
            <code>{otherClientSnippet}</code>
          </pre>
          <button
            className="snippet-copy"
            onClick={() => navigator.clipboard.writeText(otherClientSnippet)}
          >
            Copy
          </button>
        </div>
      </section>
    </div>
  );
}
