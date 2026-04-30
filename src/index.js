import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Resolve package version once at startup so /health can advertise the running build.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

// Single source of truth for the tool surface — used both for registration and
// for /health diagnostics so deploys can be verified from outside the container.
const TOOL_NAMES = ["download_attachment", "find_image_attachments_in_text"];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const OUTLINE_API_URL = (process.env.OUTLINE_API_URL || "https://app.getoutline.com/api").replace(/\/$/, "");
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "2mb";
// Hard cap on a single attachment download. Prevents a 50MB PDF from blowing
// up the caller's conversation context (base64 inflates ~1.37x).
const MAX_DOWNLOAD_BYTES = Number(process.env.MAX_DOWNLOAD_BYTES || 8 * 1024 * 1024);

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

async function downloadAttachmentBytes(attachmentId) {
  const signedUrl = await resolveSignedUrl(attachmentId);

  const res = await fetch(signedUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to download attachment from signed URL (HTTP ${res.status} ${res.statusText}).`);
  }

  // Pre-check via Content-Length when present, so we don't buffer giant files.
  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Attachment is ${declared} bytes which exceeds MAX_DOWNLOAD_BYTES (${MAX_DOWNLOAD_BYTES}).`
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Attachment is ${arrayBuffer.byteLength} bytes which exceeds MAX_DOWNLOAD_BYTES (${MAX_DOWNLOAD_BYTES}).`
    );
  }

  const mimeType =
    (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();

  // Prefer filename from the response itself; fall back to URL/UUID heuristics.
  const filename =
    parseFilenameFromContentDisposition(res.headers.get("content-disposition")) ||
    suggestFilenameFromUrl(signedUrl, attachmentId);

  return {
    id: attachmentId,
    filename,
    mime_type: mimeType,
    size_bytes: arrayBuffer.byteLength,
    content_base64: Buffer.from(arrayBuffer).toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// MCP server (one instance, request-scoped auth via AsyncLocalStorage)
// ---------------------------------------------------------------------------

function buildMcpServer() {
  const server = new McpServer({ name: "outline-attachments", version: "1.0.0" });

  server.tool(
    "download_attachment",
    "Download a single Outline attachment by ID. The MCP server fetches the file from Outline (via a short-lived signed URL) and returns the bytes inline as base64 along with metadata (filename, mime type, size). The caller is expected to write the bytes to a local temp file (e.g. `base64 -d > /tmp/<filename>`) and clean up after use. One image per call to keep token cost predictable.",
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
        const payload = await downloadAttachmentBytes(attachmentId);
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  server.tool(
    "find_image_attachments_in_text",
    "Scan markdown or document text for Outline image attachments and return the list of attachment IDs (with optional alt text). This tool does NOT download anything — use it to enumerate which images a document contains, then call download_attachment(id) per image. Pair this with the Knowledge Base / Outline MCP: fetch document body there, list refs here, download one-by-one to keep token usage bounded.",
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
        .describe("Optional cap on how many references to return (in document order)."),
    },
    async ({ text, limit }) => {
      try {
        const refs = extractImageAttachmentRefs(text);
        const work = limit ? refs.slice(0, limit) : refs;
        const payload = {
          total_found: refs.length,
          returned: work.length,
          attachments: work.map((r) => ({ id: r.id, alt: r.alt, source: r.source })),
        };
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
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

// Health for monitoring / load balancer.
// Includes version + tool surface so external smoke-tests can verify which build
// is actually running without needing an Outline token.
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    version: PKG.version,
    outline_api: OUTLINE_API_URL,
    tools: TOOL_NAMES,
    max_download_bytes: MAX_DOWNLOAD_BYTES,
  });
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
