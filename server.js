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
const SESSION_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SESSION_ID_PART_LENGTH = 4;
const SESSION_ID_PARTS = 3;
const DEFAULT_METERED_CACHE_TTL_MS = 5 * 60 * 1000;
const ICE_CACHE_MIN_TTL_MS = 60 * 1000;
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WEBSOCKET_MESSAGE_BYTES = 64 * 1024;
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

function createRequestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

const STATIC_ICE_SERVERS = buildIceServers();
const ICE_PROVIDER = String(process.env.ICE_PROVIDER || "")
  .trim()
  .toLowerCase();
const iceServerCache = {
  expiresAt: 0,
  fetchedAt: null,
  inFlightPromise: null,
  provider: null,
  servers: STATIC_ICE_SERVERS,
  source: "static",
};

function base64Encode(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function dedupeIceServers(entries) {
  const seen = new Set();
  const result = [];

  for (const entry of entries) {
    const normalized = normalizeIceEntry(entry);
    if (!normalized) {
      continue;
    }

    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function getConfiguredIceProvider() {
  if (ICE_PROVIDER) {
    return ICE_PROVIDER;
  }

  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    return "twilio";
  }

  if (process.env.METERED_APP_NAME && process.env.METERED_API_KEY) {
    return "metered";
  }

  return "static";
}

function getTwilioCacheTtlMs(payload) {
  const configuredTtlSeconds = Number(process.env.TWILIO_TURN_TTL) || Number(payload?.ttl) || 3600;
  return Math.max(ICE_CACHE_MIN_TTL_MS, configuredTtlSeconds * 1000 - 60 * 1000);
}

function getMeteredCacheTtlMs() {
  const configuredTtlMs = Number(process.env.METERED_CACHE_TTL_MS) || DEFAULT_METERED_CACHE_TTL_MS;
  return Math.max(ICE_CACHE_MIN_TTL_MS, configuredTtlMs);
}

function maybePinTwilioRegion(entry) {
  const region = String(process.env.TWILIO_TURN_REGION || "")
    .trim()
    .toLowerCase();

  if (!region) {
    return entry;
  }

  const replaceGlobal = (value) =>
    String(value || "").replace(
      /^(stun|turn|turns):global\.([a-z0-9.-]+)/i,
      (_, protocol, host) => `${protocol}:${region}.${host}`
    );

  return {
    ...entry,
    urls: Array.isArray(entry.urls) ? entry.urls.map(replaceGlobal) : replaceGlobal(entry.urls),
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(payload.message || payload.error || `Request failed with status ${response.status}`);
  }

  return payload;
}

async function fetchTwilioIceServers() {
  const accountSid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const authToken = String(process.env.TWILIO_AUTH_TOKEN || "").trim();

  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for ICE_PROVIDER=twilio");
  }

  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Tokens.json`;
  const body = new URLSearchParams();
  if (process.env.TWILIO_TURN_TTL) {
    body.set("Ttl", String(process.env.TWILIO_TURN_TTL));
  }

  const payload = await fetchJson(endpoint, {
    body,
    headers: {
      Authorization: `Basic ${base64Encode(`${accountSid}:${authToken}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  const servers = dedupeIceServers(
    Array.isArray(payload.ice_servers) ? payload.ice_servers.map(maybePinTwilioRegion) : []
  );

  if (!servers.length) {
    throw new Error("Twilio did not return any ICE servers");
  }

  return {
    fetchedAt: Date.now(),
    provider: "twilio",
    servers,
    source: "dynamic",
    ttlMs: getTwilioCacheTtlMs(payload),
  };
}

async function fetchMeteredIceServers() {
  const appName = String(process.env.METERED_APP_NAME || "").trim();
  const apiKey = String(process.env.METERED_API_KEY || "").trim();

  if (!appName || !apiKey) {
    throw new Error("METERED_APP_NAME and METERED_API_KEY are required for ICE_PROVIDER=metered");
  }

  const endpoint = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
  endpoint.searchParams.set("apiKey", apiKey);

  if (process.env.METERED_REGION) {
    endpoint.searchParams.set("region", String(process.env.METERED_REGION).trim());
  }

  const payload = await fetchJson(endpoint, {
    method: "GET",
  });

  const servers = dedupeIceServers(Array.isArray(payload) ? payload : []);
  if (!servers.length) {
    throw new Error("Metered did not return any ICE servers");
  }

  return {
    fetchedAt: Date.now(),
    provider: "metered",
    servers,
    source: "dynamic",
    ttlMs: getMeteredCacheTtlMs(),
  };
}

async function fetchProviderIceServers() {
  const provider = getConfiguredIceProvider();

  if (provider === "twilio") {
    return fetchTwilioIceServers();
  }

  if (provider === "metered") {
    return fetchMeteredIceServers();
  }

  return {
    fetchedAt: Date.now(),
    provider: "static",
    servers: STATIC_ICE_SERVERS,
    source: "static",
    ttlMs: Number.MAX_SAFE_INTEGER,
  };
}

async function getRuntimeIceConfig() {
  const provider = getConfiguredIceProvider();
  if (provider === "static") {
    return {
      fetchedAt: Date.now(),
      provider: "static",
      servers: STATIC_ICE_SERVERS,
      source: "static",
    };
  }

  if (
    iceServerCache.provider === provider &&
    iceServerCache.servers.length &&
    Date.now() < iceServerCache.expiresAt
  ) {
    return {
      fetchedAt: iceServerCache.fetchedAt,
      provider: iceServerCache.provider,
      servers: iceServerCache.servers,
      source: iceServerCache.source,
    };
  }

  if (!iceServerCache.inFlightPromise) {
    iceServerCache.inFlightPromise = fetchProviderIceServers()
      .then((config) => {
        iceServerCache.expiresAt = Date.now() + config.ttlMs;
        iceServerCache.fetchedAt = config.fetchedAt;
        iceServerCache.provider = config.provider;
        iceServerCache.servers = config.servers;
        iceServerCache.source = config.source;
        return config;
      })
      .catch((error) => {
        console.warn(`Failed to load ${provider} ICE servers:`, error.message);
        iceServerCache.expiresAt = Date.now() + ICE_CACHE_MIN_TTL_MS;
        iceServerCache.fetchedAt = Date.now();
        iceServerCache.provider = provider;
        iceServerCache.servers = STATIC_ICE_SERVERS;
        iceServerCache.source = "fallback-static";
        return {
          fetchedAt: iceServerCache.fetchedAt,
          provider,
          servers: STATIC_ICE_SERVERS,
          source: "fallback-static",
        };
      })
      .finally(() => {
        iceServerCache.inFlightPromise = null;
      });
  }

  const config = await iceServerCache.inFlightPromise;
  return {
    fetchedAt: config.fetchedAt,
    provider: config.provider,
    servers: config.servers,
    source: config.source,
  };
}

function writeWebSocketFrame(socket, opcode, payload = Buffer.alloc(0)) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  let offset = 2;

  if (payloadBuffer.length >= 126 && payloadBuffer.length < 65536) {
    offset += 2;
  } else if (payloadBuffer.length >= 65536) {
    offset += 8;
  }

  const frame = Buffer.alloc(offset + payloadBuffer.length);
  frame[0] = 0x80 | opcode;

  if (payloadBuffer.length < 126) {
    frame[1] = payloadBuffer.length;
  } else if (payloadBuffer.length < 65536) {
    frame[1] = 126;
    frame.writeUInt16BE(payloadBuffer.length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payloadBuffer.length), 2);
  }

  payloadBuffer.copy(frame, offset);
  socket.write(frame);
}

function isChannelOpen(channel) {
  if (!channel) {
    return false;
  }

  if (channel.kind === "websocket") {
    return !channel.closed && !channel.socket.destroyed && channel.socket.writable;
  }

  return !channel.writableEnded;
}

function closeChannel(channel) {
  if (!channel) {
    return;
  }

  if (channel.kind === "websocket") {
    if (channel.closed) {
      return;
    }

    channel.closed = true;
    if (!channel.socket.destroyed) {
      try {
        writeWebSocketFrame(channel.socket, 0x8);
      } catch {}
      channel.socket.end();
    }
    return;
  }

  if (!channel.writableEnded) {
    channel.end();
  }
}

function replaceParticipantChannel(participant, nextChannel) {
  if (participant.channel && participant.channel !== nextChannel) {
    closeChannel(participant.channel);
  }

  participant.channel = nextChannel;
}

function sendEvent(channel, eventName, payload) {
  if (!isChannelOpen(channel)) {
    return false;
  }

  if (channel.kind === "websocket") {
    writeWebSocketFrame(
      channel.socket,
      0x1,
      Buffer.from(JSON.stringify({ payload, type: eventName }), "utf8")
    );
    return true;
  }

  channel.write(`event: ${eventName}\n`);
  channel.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

function sendSocketResponse(channel, requestId, { data = null, error = null, ok = true, statusCode = 200 } = {}) {
  if (!requestId) {
    return false;
  }

  return sendEvent(channel, "response", {
    data,
    error,
    ok,
    requestId,
    statusCode,
  });
}

function parseWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const firstByte = buffer[0];
  const secondByte = buffer[1];
  const fin = Boolean(firstByte & 0x80);
  const opcode = firstByte & 0x0f;
  const masked = Boolean(secondByte & 0x80);
  let payloadLength = secondByte & 0x7f;
  let offset = 2;

  if (!fin) {
    throw createRequestError(1003, "Fragmented WebSocket frames are not supported");
  }

  if (payloadLength === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }

    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(MAX_WEBSOCKET_MESSAGE_BYTES)) {
      throw createRequestError(1009, "WebSocket message is too large");
    }

    payloadLength = Number(longLength);
    offset += 8;
  }

  if (payloadLength > MAX_WEBSOCKET_MESSAGE_BYTES) {
    throw createRequestError(1009, "WebSocket message is too large");
  }

  if (!masked) {
    throw createRequestError(1002, "Client WebSocket frames must be masked");
  }

  if (buffer.length < offset + 4 + payloadLength) {
    return null;
  }

  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] ^= mask[index % 4];
  }

  return {
    length: offset + payloadLength,
    opcode,
    payload,
  };
}

function createWebSocketChannel(socket, head) {
  return {
    buffer: head && head.length ? Buffer.from(head) : Buffer.alloc(0),
    closed: false,
    kind: "websocket",
    socket,
  };
}

function createSessionIdChunk() {
  let value = "";
  while (value.length < SESSION_ID_PART_LENGTH) {
    const index = crypto.randomInt(0, SESSION_ID_ALPHABET.length);
    value += SESSION_ID_ALPHABET[index];
  }
  return value;
}

function normalizeSessionId(value) {
  const cleaned = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .split("")
    .filter((character) => SESSION_ID_ALPHABET.includes(character))
    .join("")
    .slice(0, SESSION_ID_PART_LENGTH * SESSION_ID_PARTS);

  if (!cleaned) {
    return "";
  }

  const parts = cleaned.match(new RegExp(`.{1,${SESSION_ID_PART_LENGTH}}`, "g")) || [];
  return parts.join("-");
}

function createSessionId() {
  let sessionId = "";
  do {
    sessionId = Array.from({ length: SESSION_ID_PARTS }, () => createSessionIdChunk()).join("-");
  } while (sessions.has(sessionId));
  return sessionId;
}

function createParticipant(prefix) {
  return {
    channel: null,
    id: `${prefix}_${crypto.randomUUID()}`,
    token: crypto.randomBytes(24).toString("hex"),
  };
}

function getRequestedSessionId(value) {
  return normalizeSessionId(value);
}

function getSession(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    return null;
  }
  return sessions.get(normalized);
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
    closeChannel(viewer.channel);
    viewer.channel = null;
  }

  sendEvent(session.host.channel, "session-ended", { reason });
  closeChannel(session.host.channel);
  session.host.channel = null;
  sessions.delete(session.sessionId);
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
  closeChannel(viewer.channel);
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

function sendParticipantSnapshot(channel, session, match) {
  sendEvent(channel, "connected", {
    code: session.sessionId,
    role: match.role,
    sessionId: session.sessionId,
    serverTime: new Date().toISOString(),
  });

  if (match.role === "host") {
    sendEvent(channel, "session-state", {
      activeViewerId: session.activeViewerId,
      viewers: summarizeViewers(session),
    });
    sendEvent(channel, "feed-state", {
      messages: summarizeFeed(session),
    });
    return;
  }

  if (match.participant.status === "approved") {
    sendEvent(channel, "join-approved", {
      messages: summarizeFeed(session),
      viewerId: match.participant.id,
    });
    return;
  }

  if (match.participant.status === "denied") {
    sendEvent(channel, "join-denied", { viewerId: match.participant.id });
  }
}

function handleParticipantDisconnect(session, match, channel, reason) {
  if (match.participant.channel !== channel) {
    return;
  }

  match.participant.channel = null;

  if (match.role === "host") {
    endSession(session, reason);
    return;
  }

  removeViewer(session, match.participant.id, reason);
}

function assertHost(match) {
  if (!match || match.role !== "host") {
    throw createRequestError(401, "Only the host can approve viewers");
  }
}

function sendSignalToParticipant(session, match, toId, signalType, payload) {
  if (match.role === "host") {
    if (session.activeViewerId !== toId) {
      throw createRequestError(403, "Viewer is not active");
    }
  } else if (session.activeViewerId !== match.participant.id || toId !== session.host.id) {
    throw createRequestError(403, "Viewer is not approved");
  }

  const recipientMatch = getParticipant(session, toId);
  if (!recipientMatch) {
    throw createRequestError(404, "Signal recipient not found");
  }

  sendEvent(recipientMatch.participant.channel, "signal", {
    fromId: match.participant.id,
    payload,
    signalType,
  });
}

function postFeedEntry(session, match, text) {
  if (!canExchangeFeed(session, match)) {
    throw createRequestError(403, "Feed is available only during an approved session");
  }

  const normalizedText = normalizeFeedText(text);
  if (!normalizedText) {
    throw createRequestError(400, "Reply text is required");
  }

  const entry = appendFeedEntry(session, match.role, match.participant.id, normalizedText);
  sendEvent(session.host.channel, "text-feed", entry);

  if (session.activeViewerId) {
    const activeViewer = session.viewers.get(session.activeViewerId);
    sendEvent(activeViewer?.channel, "text-feed", entry);
  }

  return entry;
}

function applyViewerDecision(session, match, viewerId, approved) {
  assertHost(match);

  const viewer = session.viewers.get(viewerId);
  if (!viewer) {
    throw createRequestError(404, "Viewer not found");
  }

  if (approved) {
    if (session.activeViewerId && session.activeViewerId !== viewer.id) {
      throw createRequestError(409, "Only one active viewer is supported in this MVP");
    }

    viewer.status = "approved";
    session.activeViewerId = viewer.id;
    sendEvent(viewer.channel, "join-approved", {
      messages: summarizeFeed(session),
      viewerId: viewer.id,
    });
    return { ok: true };
  }

  viewer.status = "denied";
  sendEvent(viewer.channel, "join-denied", { viewerId: viewer.id });
  closeChannel(viewer.channel);
  viewer.channel = null;
  session.viewers.delete(viewer.id);
  return { ok: true };
}

async function handleRealtimeAction(session, match, channel, message) {
  const requestId = message?.requestId || null;

  try {
    switch (message?.type) {
      case "decision": {
        const data = applyViewerDecision(session, match, message.viewerId, Boolean(message.approved));
        sendSocketResponse(channel, requestId, { data });
        return;
      }
      case "signal": {
        sendSignalToParticipant(session, match, message.toId, message.signalType, message.payload);
        sendSocketResponse(channel, requestId, { data: { ok: true } });
        return;
      }
      case "feed": {
        const entry = postFeedEntry(session, match, message.text);
        sendSocketResponse(channel, requestId, { data: { entry, ok: true } });
        return;
      }
      case "leave": {
        sendSocketResponse(channel, requestId, { data: { ok: true } });
        if (match.role === "host") {
          endSession(session, "Host ended the session");
        } else {
          removeViewer(session, match.participant.id, "Viewer left");
        }
        return;
      }
      default:
        throw createRequestError(400, "Unknown WebSocket message type");
    }
  } catch (error) {
    sendSocketResponse(channel, requestId, {
      error: error.message,
      ok: false,
      statusCode: error.statusCode || 500,
    });
  }
}

function rejectUpgrade(socket, statusCode, statusText) {
  if (socket.destroyed) {
    return;
  }

  socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function handleSocketData(session, match, channel, chunk) {
  channel.buffer = Buffer.concat([channel.buffer, chunk]);

  while (channel.buffer.length) {
    let frame = null;

    try {
      frame = parseWebSocketFrame(channel.buffer);
    } catch {
      closeChannel(channel);
      return;
    }

    if (!frame) {
      return;
    }

    channel.buffer = channel.buffer.subarray(frame.length);

    if (frame.opcode === 0x8) {
      closeChannel(channel);
      return;
    }

    if (frame.opcode === 0x9) {
      if (isChannelOpen(channel)) {
        writeWebSocketFrame(channel.socket, 0xA, frame.payload);
      }
      continue;
    }

    if (frame.opcode === 0xA) {
      continue;
    }

    if (frame.opcode !== 0x1) {
      closeChannel(channel);
      return;
    }

    let message = null;
    try {
      message = JSON.parse(frame.payload.toString("utf8"));
    } catch {
      sendEvent(channel, "response", {
        error: "Invalid WebSocket JSON payload",
        ok: false,
        requestId: null,
        statusCode: 400,
      });
      continue;
    }

    void handleRealtimeAction(session, match, channel, message);
  }
}

function handleWebSocketUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    rejectUpgrade(socket, 404, "Not Found");
    return;
  }

  const sessionId = getRequestedSessionId(url.searchParams.get("sessionId") || url.searchParams.get("code"));
  const clientId = url.searchParams.get("clientId");
  const token = url.searchParams.get("token");
  const session = getSession(sessionId);
  const match = validateParticipant(session, clientId, token);

  if (!match) {
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  const websocketKey = req.headers["sec-websocket-key"];
  if (!websocketKey) {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(`${websocketKey}${WEBSOCKET_GUID}`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n")
  );

  socket.setNoDelay(true);

  const channel = createWebSocketChannel(socket, head);
  replaceParticipantChannel(match.participant, channel);
  sendParticipantSnapshot(channel, session, match);

  let closed = false;
  const handleClose = () => {
    if (closed) {
      return;
    }
    closed = true;
    channel.closed = true;
    handleParticipantDisconnect(
      session,
      match,
      channel,
      match.role === "host" ? "Host disconnected" : "Viewer disconnected"
    );
  };

  socket.on("data", (chunk) => {
    handleSocketData(session, match, channel, chunk);
  });
  socket.on("close", handleClose);
  socket.on("end", handleClose);
  socket.on("error", handleClose);

  if (channel.buffer.length) {
    handleSocketData(session, match, channel, Buffer.alloc(0));
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
    const iceConfig = await getRuntimeIceConfig();
    sendJson(res, 200, {
      iceProvider: iceConfig.provider,
      iceSource: iceConfig.source,
      iceServers: iceConfig.servers,
      sessionTtlMs: SESSION_TTL_MS,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      host: HOST,
      iceProvider: getConfiguredIceProvider(),
      iceServers: STATIC_ICE_SERVERS.length,
      ok: true,
      sessions: sessions.size,
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const session = {
      activeViewerId: null,
      sessionId: createSessionId(),
      createdAt: Date.now(),
      endedAt: null,
      feed: [],
      host: createParticipant("host"),
      viewers: new Map(),
    };

    sessions.set(session.sessionId, session);
    sendJson(res, 201, {
      clientId: session.host.id,
      code: session.sessionId,
      sessionId: session.sessionId,
      token: session.host.token,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const sessionId = getRequestedSessionId(
      url.searchParams.get("sessionId") || url.searchParams.get("code")
    );
    const clientId = url.searchParams.get("clientId");
    const token = url.searchParams.get("token");
    const session = getSession(sessionId);
    const match = validateParticipant(session, clientId, token);

    if (!match) {
      sendJson(res, 401, { error: "Invalid session credentials" });
      return;
    }

    replaceParticipantChannel(match.participant, res);

    res.writeHead(200, {
      "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
    });

    res.write("\n");
    sendParticipantSnapshot(res, session, match);

    req.on("close", () => {
      handleParticipantDisconnect(
        session,
        match,
        res,
        match.role === "host" ? "Host disconnected" : "Viewer disconnected"
      );
    });

    return;
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    const body = await readJsonBody(req);
    const session = getSession(body.sessionId || body.code);

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
      code: session.sessionId,
      sessionId: session.sessionId,
      token: viewer.token,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/decision") {
    const body = await readJsonBody(req);
    const session = getSession(body.sessionId || body.code);
    const match = validateParticipant(session, body.clientId, body.token);

    if (!match) {
      sendJson(res, 401, { error: "Only the host can approve viewers" });
      return;
    }

    try {
      const data = applyViewerDecision(session, match, body.viewerId, Boolean(body.approved));
      sendJson(res, 200, data);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signal") {
    const body = await readJsonBody(req);
    const session = getSession(body.sessionId || body.code);
    const match = validateParticipant(session, body.clientId, body.token);

    if (!match) {
      sendJson(res, 401, { error: "Invalid session credentials" });
      return;
    }

    try {
      sendSignalToParticipant(session, match, body.toId, body.signalType, body.payload);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/feed") {
    const body = await readJsonBody(req);
    const session = getSession(body.sessionId || body.code);
    const match = validateParticipant(session, body.clientId, body.token);

    if (!match) {
      sendJson(res, 401, { error: "Invalid session credentials" });
      return;
    }

    try {
      const entry = postFeedEntry(session, match, body.text);
      sendJson(res, 200, {
        entry,
        ok: true,
      });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/leave") {
    const body = await readJsonBody(req);
    const session = getSession(body.sessionId || body.code);
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

server.on("upgrade", (req, socket, head) => {
  try {
    handleWebSocketUpgrade(req, socket, head);
  } catch {
    rejectUpgrade(socket, 500, "Server Error");
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
