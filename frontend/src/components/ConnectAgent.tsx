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

  const url = mcpUrl.trim() || "https://<your-kriya-mcp-deployment>";
  const key = minted?.key ?? "kriya_<your key>";

  return (
    <div className="connect-agent">
      <h2>Connect your agent</h2>
      <p>
        Mint a personal key for each agent you use. Keys act as <em>you</em> — every action shows
        up as "{minted?.agent_name ?? "Claude Code"} (for you)" in the activity log. The key is
        shown once; revoke it here any time.
      </p>

      <form onSubmit={mint} className="row">
        <input
          value={agentName}
          onChange={(e) => setAgentName(e.target.value)}
          placeholder="Agent name (shown in activity)"
          maxLength={50}
        />
        <button type="submit">Create key</button>
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

      <ul className="key-list">
        {keys.map((k) => (
          <li key={k.id}>
            <code>{k.key_prefix}…</code> {k.agent_name} · created{" "}
            {new Date(k.created_at).toLocaleDateString()} ·{" "}
            {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : "never used"}
            {confirmRevoke === k.id ? (
              <>
                <span> — agents using it stop working immediately.</span>
                <button className="link" onClick={() => revoke(k.id)}>confirm revoke</button>
                <button className="link" onClick={() => setConfirmRevoke(null)}>keep</button>
              </>
            ) : (
              <button className="link" onClick={() => setConfirmRevoke(k.id)}>revoke</button>
            )}
          </li>
        ))}
        {keys.length === 0 && <li>No keys yet.</li>}
      </ul>

      <h3>Team MCP server</h3>
      <p>Your team's deployed Kriya MCP URL (ask whoever deployed it):</p>
      <input
        value={mcpUrl}
        onChange={(e) => saveMcpUrl(e.target.value)}
        placeholder="https://kriya-mcp-xyz.a.run.app"
      />

      <h3>Connect Claude Code</h3>
      <pre>
        <code>{`claude mcp add --transport http kriya ${url}/mcp \\\n  --header "Authorization: Bearer ${key}"`}</code>
      </pre>

      <h3>Any other MCP client</h3>
      <pre>
        <code>{JSON.stringify(
          { url: `${url}/mcp`, headers: { Authorization: `Bearer ${key}` } },
          null,
          2
        )}</code>
      </pre>
    </div>
  );
}
