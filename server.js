const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3000;
const CORS_ALLOW_ORIGIN = process.env.CORS_ALLOW_ORIGIN || "*";
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_TTL_MS = 60 * 60 * 1000;
const FEED_HISTORY_LIMIT = 50;
const FEED_MESSAGE_MAX_LENGTH = 280;
const sessions = new Map();
const AUTO_OPEN_BROWSER = !process.argv.includes("--no-browser");

let sea = null;
try {
  sea = require("node:sea");
} catch {
  sea = null;
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}

function applyCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Origin", CORS_ALLOW_ORIGIN);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeIceEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const urls = Array.isArray(entry.urls) ? entry.urls.filter(Boolean) : entry.urls;
  if (!urls || (Array.isArray(urls) && !urls.length)) {
    return null;
  }

  const normalized = { urls };

  if (entry.username) {
    normalized.username = String(entry.username);
  }

  if (entry.credential) {
    normalized.credential = String(entry.credential);
  }

  return normalized;
}

function isSeaRuntime() {
  return Boolean(sea && typeof sea.isSea === "function" && sea.isSea());
}

function toAssetKey(pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  return `public${cleanPath}`.replace(/\\/g, "/");
}

function getSeaAsset(pathname, contentType) {
  if (!isSeaRuntime()) {
    return null;
  }

  const assetKey = toAssetKey(pathname);
  const isTextAsset =
    contentType.startsWith("text/") ||
    contentType.includes("javascript") ||
    contentType.includes("json") ||
    contentType.includes("svg+xml");

  if (isTextAsset) {
    return Buffer.from(sea.getAsset(assetKey, "utf8"), "utf8");
  }

  return Buffer.from(sea.getAsset(assetKey));
}

function openBrowser(url) {
  const commands = {
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };

  const command = commands[process.platform];
  if (!command) {
    return;
  }

  const [file, args] = command;
  const child = spawn(file, args, {
    detached: true,
    shell: false,
    stdio: "ignore",
  });

  child.unref();
}

function buildIceServers() {
  if (process.env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS);
      if (Array.isArray(parsed)) {
        const normalized = parsed.map(normalizeIceEntry).filter(Boolean);
        if (normalized.length) {
          return normalized;
        }
      }
    } catch (error) {
      console.warn("Failed to parse ICE_SERVERS JSON:", error.message);
    }
  }

  const stunUrls = splitList(process.env.STUN_URLS);
  const turnUrls = splitList(process.env.TURN_URLS);
  const iceServers = [];

  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls.length === 1 ? stunUrls[0] : stunUrls });
  }

  if (turnUrls.length) {
    const turnServer = {
      urls: turnUrls.length === 1 ? turnUrls[0] : turnUrls,
    };

    if (process.env.TURN_USERNAME) {
      turnServer.username = process.env.TURN_USERNAME;
    }

    if (process.env.TURN_PASSWORD) {
      turnServer.credential = process.env.TURN_PASSWORD;
    }

    iceServers.push(turnServer);
  }

  if (!iceServers.length) {
    iceServers.push({ urls: "stun:stun.l.google.com:19302" });
  }

  return iceServers;
}

const ICE_SERVERS = buildIceServers();

function sendEvent(channel, eventName, payload) {
  if (!channel || channel.writableEnded) {
    return false;
  }

  channel.write(`event: ${eventName}\n`);
  channel.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function createCode() {
  let code = "";
  do {
    code = String(crypto.randomInt(100000, 1000000));
  } while (sessions.has(code));
  return code;
}

function createParticipant(prefix) {
  return {
    channel: null,
    id: `${prefix}_${crypto.randomUUID()}`,
    token: crypto.randomBytes(24).toString("hex"),
  };
}

function getSession(code) {
  if (!code) {
    return null;
  }
  return sessions.get(String(code).trim());
}

function getParticipant(session, clientId) {
  if (!session || !clientId) {
    return null;
  }

  if (session.host.id === clientId) {
    return { participant: session.host, role: "host" };
  }

  const viewer = session.viewers.get(clientId);
  if (!viewer) {
    return null;
  }

  return { participant: viewer, role: "viewer" };
}

function validateParticipant(session, clientId, token) {
  const match = getParticipant(session, clientId);
  if (!match || match.participant.token !== token) {
    return null;
  }
  return match;
}

function summarizeViewers(session) {
  return [...session.viewers.values()].map((viewer) => ({
    id: viewer.id,
    requestedAt: viewer.requestedAt,
    status: viewer.status,
  }));
}

function summarizeFeed(session) {
  return session.feed.map((entry) => ({
    createdAt: entry.createdAt,
    id: entry.id,
    senderId: entry.senderId,
    senderRole: entry.senderRole,
    text: entry.text,
  }));
}

function normalizeFeedText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FEED_MESSAGE_MAX_LENGTH);
}

function canExchangeFeed(session, match) {
  if (!session || !match) {
    return false;
  }

  if (match.role === "host") {
    return true;
  }

  return session.activeViewerId === match.participant.id && match.participant.status === "approved";
}

function appendFeedEntry(session, senderRole, senderId, text) {
  const entry = {
    createdAt: Date.now(),
    id: `feed_${crypto.randomUUID()}`,
    senderId,
    senderRole,
    text,
  };

  session.feed.push(entry);
  if (session.feed.length > FEED_HISTORY_LIMIT) {
    session.feed.shift();
  }

  return entry;
}

function endSession(session, reason) {
  if (!session || session.endedAt) {
    return;
  }

  session.endedAt = Date.now();

  for (const viewer of session.viewers.values()) {
    sendEvent(viewer.channel, "session-ended", { reason });
    if (viewer.channel && !viewer.channel.writableEnded) {
      viewer.channel.end();
    }
    viewer.channel = null;
  }

  sendEvent(session.host.channel, "session-ended", { reason });
  if (session.host.channel && !session.host.channel.writableEnded) {
    session.host.channel.end();
  }
  session.host.channel = null;
  sessions.delete(session.code);
}

function removeViewer(session, viewerId, reason) {
  if (!session) {
    return;
  }

  const viewer = session.viewers.get(viewerId);
  if (!viewer) {
    return;
  }

  if (session.activeViewerId === viewerId) {
    session.activeViewerId = null;
  }

  sendEvent(viewer.channel, "session-ended", { reason });
  if (viewer.channel && !viewer.channel.writableEnded) {
    viewer.channel.end();
  }
  viewer.channel = null;
  session.viewers.delete(viewerId);

  sendEvent(session.host.channel, "viewer-left", {
    reason,
    viewerId,
  });
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, cleanPath));
  const extension = path.extname(filePath);
  const contentType = MIME_TYPES[extension] || "application/octet-stream";

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const content = getSeaAsset(pathname, contentType) || (await fs.readFile(filePath));

    applyCorsHeaders(res);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    applyCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, {
      iceServers: ICE_SERVERS,
      sessionTtlMs: SESSION_TTL_MS,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      host: HOST,
      iceServers: ICE_SERVERS.length,
      ok: true,
      sessions: sessions.size,
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const session = {
      activeViewerId: null,
      code: createCode(),
      createdAt: Date.now(),
      endedAt: null,
      feed: [],
      host: createParticipant("host"),
      viewers: new Map(),
    };

    sessions.set(session.code, session);
    sendJson(res, 201, {
      clientId: session.host.id,
      code: session.code,
      token: session.host.token,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const code = url.searchParams.get("code");
    const clientId = url.searchParams.get("clientId");
    const token = url.searchParams.get("token");
    const session = getSession(code);
    const match = validateParticipant(session, clientId, token);

    if (!match) {
      sendJson(res, 401, { error: "Invalid session credentials" });
      return;
    }

    if (match.participant.channel && !match.participant.channel.writableEnded) {
      match.participant.channel.end();
    }
    match.participant.channel = res;

    res.writeHead(200, {
      "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    });

    res.write("\n");
    sendEvent(res, "connected", {
      code: session.code,
      role: match.role,
      serverTime: new Date().toISOString(),
    });

    if (match.role === "host") {
      sendEvent(res, "session-state", {
        activeViewerId: session.activeViewerId,
        viewers: summarizeViewers(session),
      });
      sendEvent(res, "feed-state", {
        messages: summarizeFeed(session),
      });
    } else if (match.participant.status === "approved") {
      sendEvent(res, "join-approved", {
        messages: summarizeFeed(session),
        viewerId: match.participant.id,
      });
    } else if (match.participant.status === "denied") {
      sendEvent(res, "join-denied", { viewerId: match.participant.id });
    }

    req.on("close", () => {
      if (match.participant.channel === res) {
        match.participant.channel = null;
      }

      if (match.role === "host") {
        endSession(session, "Host disconnected");
        return;
      }

      removeViewer(session, match.participant.id, "Viewer disconnected");
    });

    return;
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    const body = await readJsonBody(req);
    const session = getSession(body.code);

    if (!session) {
      sendJson(res, 404, { error: "Session not found" });
      return;
    }

    const viewer = {
      ...createParticipant("viewer"),
      requestedAt: Date.now(),
      status: "pending",
    };

    session.viewers.set(viewer.id, viewer);
    sendEvent(session.host.channel, "viewer-request", {
      requestedAt: viewer.requestedAt,
      viewerId: viewer.id,
    });

    sendJson(res, 201, {
      clientId: viewer.id,
      code: session.code,
      token: viewer.token,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/decision") {
    const body = await readJsonBody(req);
    const session = getSession(body.code);
    const match = validateParticipant(session, body.clientId, body.token);

    if (!match || match.role !== "host") {
      sendJson(res, 401, { error: "Only the host can approve viewers" });
      return;
    }

    const viewer = session.viewers.get(body.viewerId);
    if (!viewer) {
      sendJson(res, 404, { error: "Viewer not found" });
      return;
    }

    if (body.approved) {
      if (session.activeViewerId && session.activeViewerId !== viewer.id) {
        sendJson(res, 409, {
          error: "Only one active viewer is supported in this MVP",
        });
        return;
      }

      viewer.status = "approved";
      session.activeViewerId = viewer.id;
      sendEvent(viewer.channel, "join-approved", {
        messages: summarizeFeed(session),
        viewerId: viewer.id,
      });
      sendJson(res, 200, { ok: true });
      return;
    }

    viewer.status = "denied";
    sendEvent(viewer.channel, "join-denied", { viewerId: viewer.id });
    if (viewer.channel && !viewer.channel.writableEnded) {
      viewer.channel.end();
    }
    viewer.channel = null;
    session.viewers.delete(viewer.id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signal") {
    const body = await readJsonBody(req);
    const session = getSession(body.code);
    const match = validateParticipant(session, body.clientId, body.token);

    if (!match) {
      sendJson(res, 401, { error: "Invalid session credentials" });
      return;
    }

    if (match.role === "host") {
      if (session.activeViewerId !== body.toId) {
        sendJson(res, 403, { error: "Viewer is not active" });
        return;
      }
    } else if (session.activeViewerId !== match.participant.id || body.toId !== session.host.id) {
      sendJson(res, 403, { error: "Viewer is not approved" });
      return;
    }

    const recipientMatch = getParticipant(session, body.toId);
    if (!recipientMatch) {
      sendJson(res, 404, { error: "Signal recipient not found" });
      return;
    }

    sendEvent(recipientMatch.participant.channel, "signal", {
      fromId: match.participant.id,
      payload: body.payload,
      signalType: body.signalType,
    });

    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/feed") {
    const body = await readJsonBody(req);
    const session = getSession(body.code);
    const match = validateParticipant(session, body.clientId, body.token);

    if (!match) {
      sendJson(res, 401, { error: "Invalid session credentials" });
      return;
    }

    if (!canExchangeFeed(session, match)) {
      sendJson(res, 403, { error: "Feed is available only during an approved session" });
      return;
    }

    const text = normalizeFeedText(body.text);
    if (!text) {
      sendJson(res, 400, { error: "Reply text is required" });
      return;
    }

    const entry = appendFeedEntry(session, match.role, match.participant.id, text);
    sendEvent(session.host.channel, "text-feed", entry);

    if (session.activeViewerId) {
      const activeViewer = session.viewers.get(session.activeViewerId);
      sendEvent(activeViewer?.channel, "text-feed", entry);
    }

    sendJson(res, 200, {
      entry,
      ok: true,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/leave") {
    const body = await readJsonBody(req);
    const session = getSession(body.code);
    const match = validateParticipant(session, body.clientId, body.token);

    if (!match) {
      sendJson(res, 401, { error: "Invalid session credentials" });
      return;
    }

    if (match.role === "host") {
      endSession(session, "Host ended the session");
      sendJson(res, 200, { ok: true });
      return;
    }

    removeViewer(session, match.participant.id, "Viewer left");
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "API route not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Server error" });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      endSession(session, "Session expired");
    }
  }
}, 60 * 1000).unref();

setInterval(() => {
  for (const session of sessions.values()) {
    sendEvent(session.host.channel, "ping", { time: Date.now() });
    for (const viewer of session.viewers.values()) {
      sendEvent(viewer.channel, "ping", { time: Date.now() });
    }
  }
}, 20 * 1000).unref();

server.listen(PORT, HOST, () => {
  const launchUrl = `http://localhost:${PORT}`;
  console.log(`HideMyScreen is running on http://${HOST}:${PORT}`);

  if (isSeaRuntime() && AUTO_OPEN_BROWSER) {
    openBrowser(launchUrl);
  }
});
