# outline-attachments-mcp (server)

HTTP MCP server that resolves Outline attachment IDs to short-lived signed download URLs.
Designed to run **next to** the team's self-hosted Outline at `knowledge-vault.digitalwert.net`
and be reached by Claude Code clients at `imageprocessing.digitalwert.net/mcp`.

The service is **stateless and per-request authenticated**: every MCP call must carry the
caller's own Outline API token in the `Authorization` header. The token is forwarded to
Outline, so Outline's own ACLs apply — the server never holds team-wide credentials.

## Tools exposed

- `resolve_attachment_url(id)` — single attachment UUID → signed URL
- `resolve_attachment_urls_from_text(text, limit?)` — scans markdown for image attachments, returns one signed URL per image

The server **does not** download files itself. The caller (Claude on the user's machine)
fetches each signed URL with `curl` and processes locally — this preserves the
"no Claude vision tokens" property when paired with `/local-vision`.

## Deployment (Docker + Caddy)

The expected setup at digitalwert: same host as the existing Outline container, separate
container, behind the existing Caddy reverse proxy.

### 1. DNS

In domainfactory: add an A-record `imageprocessing.digitalwert.net` pointing to the same
IP as `knowledge-vault.digitalwert.net`.

### 2. Build + start the container

```bash
cd services/outline-attachments-mcp
docker compose up -d --build
```

This binds the service to `127.0.0.1:3789` only — it's not directly reachable from the
internet until Caddy is configured.

### 3. Caddy config

Append `caddy/Caddyfile.snippet` to your live Caddyfile and reload Caddy:

```bash
sudo nano /etc/caddy/Caddyfile        # or wherever your Caddyfile lives
sudo systemctl reload caddy
```

Caddy will request a Let's Encrypt cert for the new hostname automatically.

### 4. Smoke test

```bash
# Health endpoint (no auth):
curl https://imageprocessing.digitalwert.net/health
# -> {"status":"ok","outline_api":"https://knowledge-vault.digitalwert.net/api"}

# MCP without token: 401
curl -X POST https://imageprocessing.digitalwert.net/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'

# MCP with token: SSE response listing tools
curl -X POST https://imageprocessing.digitalwert.net/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer ol_..." \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

## Configuration

Environment variables (see `docker-compose.yml`):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port the Express app listens on inside the container |
| `OUTLINE_API_URL` | `https://app.getoutline.com/api` | **Set this** to your self-hosted Outline API URL (no trailing slash) |
| `REQUEST_BODY_LIMIT` | `2mb` | Max request body size (Express `json` middleware) |

## Security model

- **No team credentials on the server.** The container holds zero Outline tokens at rest.
- **Per-request auth.** Each Claude call passes a Bearer token. Token bytes never leave RAM.
- **Outline ACLs apply.** A user's Bearer token grants exactly what their Outline account allows.
- **Public-internet-facing is acceptable** because Outline accounts are gated by Google
  Workspace SSO — only digitalwert members can mint API tokens in the first place.

## Updating

```bash
cd services/outline-attachments-mcp
git pull
docker compose up -d --build
```

The container restarts in seconds; existing in-flight MCP requests fail and the client
reconnects automatically.

## Logs / troubleshooting

```bash
docker compose logs -f outline-attachments-mcp
```

If Caddy returns 502, the container probably isn't bound to `127.0.0.1:3789`. Check
`docker compose ps` and `curl http://127.0.0.1:3789/health` directly on the host.
