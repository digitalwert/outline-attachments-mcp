# outline-attachments-mcp (server)

HTTP MCP server that downloads Outline attachments and returns the bytes inline to the
caller. Designed to run **next to** the team's self-hosted Outline at
`knowledge-vault.digitalwert.net` and be reached by Claude Code clients at
`imageprocessing.digitalwert.net/mcp`.

The service is **stateless and per-request authenticated**: every MCP call must carry the
caller's own Outline API token in the `Authorization` header. The token is forwarded to
Outline, so Outline's own ACLs apply — the server never holds team-wide credentials.

## Tools exposed

- `download_attachment(id)` — fetches the file from Outline server-side and returns
  `{ id, filename, mime_type, size_bytes, content_base64 }`. The caller is expected to
  decode the base64 into a local temp file and remove it after use.
- `find_image_attachments_in_text(text, limit?)` — scans markdown for image attachment
  refs and returns the list of IDs (with alt text). Does **not** download. Pair with
  `download_attachment` per image to keep token usage bounded.

The server downloads each file once on the server side and streams it back to the caller
as base64. There is a hard `MAX_DOWNLOAD_BYTES` cap (default 8 MiB) to keep a single
oversized attachment from blowing up the conversation context.

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
| `MAX_DOWNLOAD_BYTES` | `8388608` (8 MiB) | Refuse to inline-return any attachment larger than this. base64 inflates ~1.37×, so the wire payload is bounded at ~11.5 MiB. |

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
