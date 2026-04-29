import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const OUTLINE_API_URL = (process.env.OUTLINE_API_URL || "https://app.getoutline.com/api").replace(/\/$/, "");
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "2mb";

// ---------------------------------------------------------------------------
// Per-request context (bearer token)
// ---------------------------------------------------------------------------

const requestContext = new AsyncLocalStorage();

function getBearerToken() {
  const ctx = requestContext.getStore();
  if (!ctx?.token) {
    throw new Error(
      "No Outline API token in request. Configure your client to send 'Authorization: Bearer <ol_...>' to this MCP."
    );
  }
  return ctx.token;
}

// ---------------------------------------------------------------------------
// Outline API helpers
// ---------------------------------------------------------------------------

const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function extractAttachmentId(input) {
  const trimmed = String(input).trim();
  if (ATTACHMENT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  const queryMatch = trimmed.match(/[?&]id=([0-9a-f-]+)/i);
  if (queryMatch && ATTACHMENT_ID_RE.test(queryMatch[1])) return queryMatch[1].toLowerCase();
  const uuidMatch = trimmed.match(UUID_RE);
  if (uuidMatch) return uuidMatch[0].toLowerCase();
  throw new Error(`Could not extract a valid attachment UUID from: ${input}`);
}

function extractImageAttachmentRefs(text) {
  const refs = [];
  const seen = new Set();

  // Markdown image syntax: ![alt](url)
  const mdImage = /!\[([^\]]*)\]\(([^)]*attachments\.redirect[^)]*)\)/gi;
  let m;
  while ((m = mdImage.exec(text)) !== null) {
    const idMatch = m[2].match(/[?&]id=([0-9a-f-]+)/i);
    if (!idMatch) continue;
    const id = idMatch[1].toLowerCase();
    if (!ATTACHMENT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    refs.push({ id, alt: m[1] || null, source: "markdown_image" });
  }

  // Bare attachments.redirect URLs
  const bare = /attachments\.redirect[^?\s)]*\?id=([0-9a-f-]+)/gi;
  while ((m = bare.exec(text)) !== null) {
    const id = m[1].toLowerCase();
    if (!ATTACHMENT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    refs.push({ id, alt: null, source: "bare_url" });
  }

  return refs;
}

function parseFilenameFromContentDisposition(header) {
  if (!header) return null;
  const star = header.match(/filename\*=(?:UTF-8'')?([^;\n]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through
    }
  }
  const plain = header.match(/filename=([^;\n]+)/i);
  if (plain) return plain[1].trim().replace(/^"|"$/g, "");
  return null;
}

function suggestFilenameFromUrl(signedUrl, attachmentId) {
  try {
    const url = new URL(signedUrl);
    const cdQuery = url.searchParams.get("response-content-disposition");
    const fromQuery = parseFilenameFromContentDisposition(cdQuery);
    if (fromQuery) return fromQuery;

    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() || "");
    if (last && /\.[a-z0-9]{1,8}$/i.test(last)) return last;
  } catch {
    // ignore
  }
  return attachmentId;
}

async function resolveSignedUrl(attachmentId) {
  const token = getBearerToken();

  const res = await fetch(`${OUTLINE_API_URL}/attachments.redirect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ id: attachmentId }),
    redirect: "manual",
  });

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (!location) throw new Error(`Outline returned ${res.status} without a Location header`);
    return location;
  }

  if (res.status === 401)
    throw new Error("Outline rejected the API token (401). Check your connector's Authorization header.");
  if (res.status === 403)
    throw new Error("Token lacks permission for this attachment (403).");
  if (res.status === 404)
    throw new Error(`Attachment not found: ${attachmentId} (404).`);

  const body = await res.text().catch(() => "");
  throw new Error(`Unexpected response from Outline (HTTP ${res.status}): ${body.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// MCP server (one instance, request-scoped auth via AsyncLocalStorage)
// ---------------------------------------------------------------------------

function buildMcpServer() {
  const server = new McpServer({ name: "outline-attachments", version: "1.0.0" });

  server.tool(
    "resolve_attachment_url",
    "Resolve a single Outline attachment ID to a short-lived signed download URL. The signed URL has temporary credentials embedded — fetch it from the user's local machine (e.g. via curl) to download the file. Use this when you already have a specific attachment UUID.",
    {
      id: z
        .string()
        .min(1)
        .describe(
          "Outline attachment ID (UUID). Also accepts an Outline URL containing the ID, e.g. /api/attachments.redirect?id=<uuid>."
        ),
    },
    async ({ id }) => {
      try {
        const attachmentId = extractAttachmentId(id);
        const signedUrl = await resolveSignedUrl(attachmentId);
        const suggested = suggestFilenameFromUrl(signedUrl, attachmentId);

        const payload = {
          id: attachmentId,
          url: signedUrl,
          suggested_filename: suggested,
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "resolve_attachment_urls_from_text",
    "Scan markdown or document text for Outline image attachments and return a signed download URL for each. Designed for the workflow: another tool (e.g. the Knowledge Base / Outline MCP) returns a document body, and this tool extracts every image attachment ID from it and resolves a signed URL per image. The caller (Claude on the user's machine) is then expected to download each URL locally with curl and pass file paths to a vision tool. Use this — not resolve_attachment_url — when you have the document body and want all its images at once.",
    {
      text: z
        .string()
        .min(1)
        .describe(
          "Markdown or plain text from an Outline document. The tool scans for ![alt](.../attachments.redirect?id=<uuid>) and bare attachment URLs."
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Optional cap on how many attachments to resolve (in document order)."),
    },
    async ({ text, limit }) => {
      try {
        const refs = extractImageAttachmentRefs(text);
        if (refs.length === 0) {
          return {
            content: [{ type: "text", text: "No Outline image attachments found in the provided text." }],
          };
        }
        const work = limit ? refs.slice(0, limit) : refs;

        const results = await Promise.all(
          work.map(async (ref) => {
            try {
              const url = await resolveSignedUrl(ref.id);
              return {
                ok: true,
                id: ref.id,
                alt: ref.alt,
                url,
                suggested_filename: suggestFilenameFromUrl(url, ref.id),
              };
            } catch (err) {
              return { ok: false, id: ref.id, alt: ref.alt, error: err.message };
            }
          })
        );

        const summary = {
          total_found: refs.length,
          resolved: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          attachments: results,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express HTTP layer
// ---------------------------------------------------------------------------

function parseBearer(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== "string") return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

const app = express();
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));

// Health for monitoring / load balancer
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", outline_api: OUTLINE_API_URL });
});

// MCP endpoint
app.post("/mcp", async (req, res) => {
  const token = parseBearer(req);
  if (!token) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Missing or malformed Authorization header. Expected 'Bearer <ol_...>'." },
      id: req.body?.id ?? null,
    });
    return;
  }

  await requestContext.run({ token }, async () => {
    try {
      const server = buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless: each request is independent
      });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: req.body?.id ?? null,
        });
      }
    }
  });
});

// MCP HTTP transport spec: GET /mcp opens the server-to-client stream.
// In stateless mode we don't keep server-initiated streams open — return 405.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed (server runs in stateless mode)" },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`outline-attachments MCP listening on :${PORT} (Outline API: ${OUTLINE_API_URL})`);
});
