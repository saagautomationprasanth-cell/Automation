let rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const FEED_TEXT_MAX_LENGTH = 280;
const SERVER_URL_STORAGE_KEY = "hideMyScreen.serverUrl";
const LOCAL_SERVER_URL = window.location.origin;

const connectionState = {
  serverUrl: loadSavedServerUrl(),
};

function sanitizeServerUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return LOCAL_SERVER_URL;
  }

  const normalized = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return new URL(normalized).toString().replace(/\/$/, "");
}

function loadSavedServerUrl() {
  try {
    return sanitizeServerUrl(localStorage.getItem(SERVER_URL_STORAGE_KEY) || LOCAL_SERVER_URL);
  } catch {
    return LOCAL_SERVER_URL;
  }
}

function buildApiUrl(path) {
  return new URL(path, connectionState.serverUrl).toString();
}

function describeCurrentServer(extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  elements.currentServerLabel.textContent = `Current shared server: ${connectionState.serverUrl}.${suffix}`;
}

async function loadRuntimeConfig() {
  try {
    const response = await fetch(buildApiUrl("/api/config"));
    const data = await response.json();

    if (response.ok && Array.isArray(data.iceServers) && data.iceServers.length) {
      rtcConfig = {
        iceServers: data.iceServers,
      };
    }

    describeCurrentServer("Unique session IDs are created on this server.");
  } catch (error) {
    describeCurrentServer("This server could not be reached.");
    console.warn("Falling back to default ICE config:", error);
    throw error;
  }
}

const hostState = {
  activeViewerId: null,
  clientId: null,
  code: null,
  eventSource: null,
  feedEntries: [],
  feedIds: new Set(),
  pc: null,
  pendingViewers: new Map(),
  stream: null,
  token: null,
};

const viewerState = {
  approved: false,
  clientId: null,
  code: null,
  eventSource: null,
  hostId: null,
  feedEntries: [],
  feedIds: new Set(),
  playbackPromptShown: false,
  pc: null,
  remoteStream: null,
  token: null,
};

const elements = {
  currentServerLabel: document.getElementById("currentServerLabel"),
  clearHostLogBtn: document.getElementById("clearHostLogBtn"),
  clearViewerLogBtn: document.getElementById("clearViewerLogBtn"),
  enableRemoteAudioBtn: document.getElementById("enableRemoteAudioBtn"),
  endHostBtn: document.getElementById("endHostBtn"),
  hostCode: document.getElementById("hostCode"),
  hostFeedCount: document.getElementById("hostFeedCount"),
  hostFeedEmpty: document.getElementById("hostFeedEmpty"),
  hostFeedHighlight: document.getElementById("hostFeedHighlight"),
  hostFeedHighlightMeta: document.getElementById("hostFeedHighlightMeta"),
  hostFeedHighlightText: document.getElementById("hostFeedHighlightText"),
  hostFeedList: document.getElementById("hostFeedList"),
  hostLog: document.getElementById("hostLog"),
  hostStatus: document.getElementById("hostStatus"),
  joinViewerBtn: document.getElementById("joinViewerBtn"),
  leaveViewerBtn: document.getElementById("leaveViewerBtn"),
  localPreview: document.getElementById("localPreview"),
  pendingCount: document.getElementById("pendingCount"),
  pendingEmpty: document.getElementById("pendingEmpty"),
  pendingList: document.getElementById("pendingList"),
  remoteScreen: document.getElementById("remoteScreen"),
  saveServerUrlBtn: document.getElementById("saveServerUrlBtn"),
  shareAudioToggle: document.getElementById("shareAudioToggle"),
  startHostBtn: document.getElementById("startHostBtn"),
  serverUrlInput: document.getElementById("serverUrlInput"),
  useLocalServerBtn: document.getElementById("useLocalServerBtn"),
  viewerCodeInput: document.getElementById("viewerCodeInput"),
  viewerFeedCount: document.getElementById("viewerFeedCount"),
  viewerFeedEmpty: document.getElementById("viewerFeedEmpty"),
  viewerFeedInput: document.getElementById("viewerFeedInput"),
  viewerFeedList: document.getElementById("viewerFeedList"),
  viewerLog: document.getElementById("viewerLog"),
  viewerPlaceholder: document.getElementById("viewerPlaceholder"),
  viewerStatus: document.getElementById("viewerStatus"),
  viewerAudioAssist: document.getElementById("viewerAudioAssist"),
  sendViewerFeedBtn: document.getElementById("sendViewerFeedBtn"),
};

function formatTime(value = Date.now()) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 6);
}

function addLog(container, message) {
  const item = document.createElement("div");
  item.className = "log-item";
  item.innerHTML = `
    <div class="log-meta">
      <span>${formatTime()}</span>
    </div>
    <strong class="log-message">${message}</strong>
  `;
  container.prepend(item);
}

function hasActiveSession() {
  return Boolean(hostState.code || viewerState.code);
}

function rememberServerUrl(nextUrl) {
  connectionState.serverUrl = sanitizeServerUrl(nextUrl);
  localStorage.setItem(SERVER_URL_STORAGE_KEY, connectionState.serverUrl);
  elements.serverUrlInput.value = connectionState.serverUrl;
  describeCurrentServer("Unique session IDs are created on this server.");
}

async function saveServerUrl(nextUrl) {
  if (hasActiveSession()) {
    const message = "End the active session before changing the shared server.";
    addLog(elements.hostLog, message);
    addLog(elements.viewerLog, message);
    describeCurrentServer(message);
    return false;
  }

  try {
    rememberServerUrl(nextUrl);
    await loadRuntimeConfig();
    addLog(elements.hostLog, `Shared server updated: ${connectionState.serverUrl}`);
    addLog(elements.viewerLog, `Shared server updated: ${connectionState.serverUrl}`);
    return true;
  } catch (error) {
    const message = `Shared server is not reachable: ${error.message}`;
    addLog(elements.hostLog, message);
    addLog(elements.viewerLog, message);
    return false;
  }
}

function setHostStatus(text) {
  elements.hostStatus.textContent = text;
}

function setViewerStatus(text) {
  elements.viewerStatus.textContent = text;
}

function updateViewerPlaceholder() {
  const hasStream = Boolean(elements.remoteScreen.srcObject);
  elements.viewerPlaceholder.hidden = hasStream;
}

function resetFeedState(state) {
  state.feedEntries = [];
  state.feedIds = new Set();
}

function storeFeedEntry(state, entry) {
  if (!entry?.id || state.feedIds.has(entry.id)) {
    return false;
  }

  state.feedIds.add(entry.id);
  state.feedEntries.push(entry);
  state.feedEntries.sort((left, right) => left.createdAt - right.createdAt);
  return true;
}

function replaceFeedEntries(state, entries = []) {
  resetFeedState(state);
  for (const entry of entries) {
    storeFeedEntry(state, entry);
  }
}

function buildFeedItem(entry) {
  const item = document.createElement("article");
  item.className = `feed-item ${entry.senderRole === "viewer" ? "feed-item-viewer" : "feed-item-host"}`;

  const meta = document.createElement("div");
  meta.className = "feed-meta";

  const author = document.createElement("strong");
  author.textContent = entry.senderRole === "viewer" ? "Remote reply" : "Host note";

  const timestamp = document.createElement("span");
  timestamp.textContent = formatTime(entry.createdAt);

  meta.append(author, timestamp);

  const text = document.createElement("p");
  text.className = "feed-text";
  text.textContent = entry.text;

  item.append(meta, text);
  return item;
}

function renderHostFeed() {
  const messages = [...hostState.feedEntries].reverse();
  elements.hostFeedCount.textContent = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
  elements.hostFeedList.innerHTML = "";
  elements.hostFeedEmpty.hidden = messages.length > 0;

  const latestViewerReply = messages.find((entry) => entry.senderRole === "viewer");
  elements.hostFeedHighlight.hidden = !latestViewerReply;

  if (latestViewerReply) {
    elements.hostFeedHighlightText.textContent = latestViewerReply.text;
    elements.hostFeedHighlightMeta.textContent = `Remote reply at ${formatTime(latestViewerReply.createdAt)}`;
  } else {
    elements.hostFeedHighlightText.textContent = "";
    elements.hostFeedHighlightMeta.textContent = "";
  }

  for (const entry of messages) {
    elements.hostFeedList.append(buildFeedItem(entry));
  }
}

function renderViewerFeed() {
  const messages = [...viewerState.feedEntries].reverse();
  elements.viewerFeedCount.textContent = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
  elements.viewerFeedList.innerHTML = "";
  elements.viewerFeedEmpty.hidden = messages.length > 0;

  for (const entry of messages) {
    elements.viewerFeedList.append(buildFeedItem(entry));
  }
}

function getViewerFeedDraft() {
  return elements.viewerFeedInput.value.replace(/\s+/g, " ").trim().slice(0, FEED_TEXT_MAX_LENGTH);
}

function updateViewerFeedComposer() {
  const canSend = viewerState.approved && Boolean(getViewerFeedDraft());
  elements.viewerFeedInput.disabled = !viewerState.approved;
  elements.sendViewerFeedBtn.disabled = !canSend;
}

async function tryPlayRemoteScreen() {
  if (!elements.remoteScreen.srcObject) {
    return;
  }

  try {
    await elements.remoteScreen.play();
    elements.viewerAudioAssist.hidden = true;
    viewerState.playbackPromptShown = false;
  } catch (error) {
    elements.viewerAudioAssist.hidden = false;
    if (!viewerState.playbackPromptShown) {
      addLog(elements.viewerLog, "Remote playback is ready. Click Enable audio if your browser blocks autoplay.");
      viewerState.playbackPromptShown = true;
    }
  }
}

function renderPendingViewers() {
  const viewers = [...hostState.pendingViewers.values()].sort(
    (left, right) => left.requestedAt - right.requestedAt
  );

  elements.pendingList.innerHTML = "";
  elements.pendingCount.textContent = `${viewers.length} waiting`;
  elements.pendingEmpty.hidden = viewers.length > 0;

  for (const viewer of viewers) {
    const item = document.createElement("li");
    item.className = "request-item";
    item.innerHTML = `
      <div class="request-meta">
        <strong>${viewer.id.slice(0, 16)}</strong>
        <span>${formatTime(viewer.requestedAt)}</span>
      </div>
      <div class="request-actions">
        <button data-action="approve" data-viewer-id="${viewer.id}" ${hostState.activeViewerId ? "disabled" : ""}>Approve</button>
        <button data-action="deny" data-viewer-id="${viewer.id}">Deny</button>
      </div>
    `;
    elements.pendingList.append(item);
  }
}

async function apiRequest(path, payload) {
  const response = await fetch(buildApiUrl(path), {
    body: payload ? JSON.stringify(payload) : undefined,
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    method: payload ? "POST" : "GET",
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

function wireEventSource(source, handlers) {
  const registrations = [
    ["connected", handlers.connected],
    ["feed-state", handlers.feedState],
    ["join-approved", handlers.joinApproved],
    ["join-denied", handlers.joinDenied],
    ["ping", handlers.ping],
    ["session-ended", handlers.sessionEnded],
    ["session-state", handlers.sessionState],
    ["signal", handlers.signal],
    ["text-feed", handlers.textFeed],
    ["viewer-left", handlers.viewerLeft],
    ["viewer-request", handlers.viewerRequest],
  ];

  for (const [eventName, handler] of registrations) {
    if (!handler) {
      continue;
    }

    source.addEventListener(eventName, (event) => {
      const payload = JSON.parse(event.data);
      handler(payload);
    });
  }
}

function buildEventSourceUrl(code, clientId, token) {
  const params = new URLSearchParams({ clientId, code, token });
  return buildApiUrl(`/api/events?${params.toString()}`);
}

async function sendSignal(state, toId, signalType, payload) {
  await apiRequest("/api/signal", {
    clientId: state.clientId,
    code: state.code,
    payload,
    signalType,
    toId,
    token: state.token,
  });
}

async function ensureDisplayStream() {
  if (hostState.stream) {
    return hostState.stream;
  }

  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("This browser does not support screen sharing");
  }

  const includeSystemAudio = elements.shareAudioToggle.checked;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: includeSystemAudio
      ? {
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        }
      : false,
    systemAudio: includeSystemAudio ? "include" : "exclude",
    video: {
      frameRate: { ideal: 12, max: 15 },
    },
  });

  if (includeSystemAudio) {
    if (stream.getAudioTracks().length > 0) {
      addLog(elements.hostLog, "Screen sharing includes system audio when the chosen browser surface allows it.");
    } else {
      addLog(
        elements.hostLog,
        "The selected screen/window did not expose system audio. In the picker, choose a surface that supports audio and enable Share audio."
      );
    }
  } else {
    addLog(elements.hostLog, "Screen sharing started without shared laptop audio.");
  }

  const [track] = stream.getVideoTracks();
  if (track) {
    track.addEventListener("ended", async () => {
      addLog(elements.hostLog, "Screen sharing stopped on the host device.");
      hostState.stream = null;
      elements.localPreview.srcObject = null;

      if (hostState.code) {
        await leaveHostSession(false);
      }
    });
  }

  hostState.stream = stream;
  elements.localPreview.srcObject = stream;
  return stream;
}

function destroyHostPeer() {
  if (hostState.pc) {
    hostState.pc.onicecandidate = null;
    hostState.pc.onconnectionstatechange = null;
    hostState.pc.close();
    hostState.pc = null;
  }

  hostState.activeViewerId = null;
  if (hostState.code) {
    setHostStatus("Waiting");
  }
  renderPendingViewers();
}

function destroyViewerPeer() {
  if (viewerState.pc) {
    viewerState.pc.onicecandidate = null;
    viewerState.pc.ontrack = null;
    viewerState.pc.onconnectionstatechange = null;
    viewerState.pc.close();
    viewerState.pc = null;
  }

  viewerState.hostId = null;
  viewerState.remoteStream = null;
  viewerState.playbackPromptShown = false;
  elements.remoteScreen.srcObject = null;
  elements.viewerAudioAssist.hidden = true;
  updateViewerPlaceholder();
}

async function buildHostPeer(viewerId) {
  destroyHostPeer();

  const pc = new RTCPeerConnection(rtcConfig);
  hostState.pc = pc;
  hostState.activeViewerId = viewerId;

  for (const track of hostState.stream.getTracks()) {
    pc.addTrack(track, hostState.stream);
  }

  pc.onicecandidate = async (event) => {
    if (!event.candidate || hostState.activeViewerId !== viewerId) {
      return;
    }

    try {
      await sendSignal(hostState, viewerId, "candidate", event.candidate);
    } catch (error) {
      addLog(elements.hostLog, `ICE send failed: ${error.message}`);
    }
  };

  pc.onconnectionstatechange = () => {
    addLog(elements.hostLog, `Connection state: ${pc.connectionState}`);

    if (["closed", "disconnected", "failed"].includes(pc.connectionState)) {
      hostState.activeViewerId = null;
      setHostStatus("Waiting");
      renderPendingViewers();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await sendSignal(hostState, viewerId, "offer", offer);
}

function buildViewerPeer(hostId) {
  if (viewerState.pc) {
    return viewerState.pc;
  }

  const pc = new RTCPeerConnection(rtcConfig);
  viewerState.pc = pc;
  viewerState.hostId = hostId;

  pc.ontrack = (event) => {
    const [remoteStream] = event.streams;
    const isNewStream = viewerState.remoteStream?.id !== remoteStream?.id;
    viewerState.remoteStream = remoteStream;
    elements.remoteScreen.srcObject = remoteStream;
    updateViewerPlaceholder();
    if (isNewStream) {
      if (remoteStream?.getAudioTracks().length) {
        addLog(elements.viewerLog, "Remote system audio is available. Use Enable audio if autoplay is blocked.");
      } else {
        addLog(elements.viewerLog, "Remote screen connected without shared audio.");
      }
    }
    void tryPlayRemoteScreen();
  };

  pc.onicecandidate = async (event) => {
    if (!event.candidate || !viewerState.hostId) {
      return;
    }

    try {
      await sendSignal(viewerState, viewerState.hostId, "candidate", event.candidate);
    } catch (error) {
      addLog(elements.viewerLog, `ICE send failed: ${error.message}`);
    }
  };

  pc.onconnectionstatechange = () => {
    addLog(elements.viewerLog, `Connection state: ${pc.connectionState}`);
  };

  return pc;
}

function resetHostUi() {
  elements.hostCode.textContent = "------";
  setHostStatus("Idle");
  elements.startHostBtn.disabled = false;
  elements.endHostBtn.disabled = true;
  hostState.pendingViewers.clear();
  resetFeedState(hostState);
  renderHostFeed();
  renderPendingViewers();
}

function resetViewerUi() {
  setViewerStatus("Idle");
  elements.joinViewerBtn.disabled = false;
  elements.leaveViewerBtn.disabled = true;
  elements.viewerFeedInput.value = "";
  viewerState.approved = false;
  resetFeedState(viewerState);
  renderViewerFeed();
  updateViewerFeedComposer();
  updateViewerPlaceholder();
}

async function startHostSession() {
  try {
    await loadRuntimeConfig();
    const data = await apiRequest("/api/sessions", {});
    hostState.code = data.code;
    hostState.clientId = data.clientId;
    hostState.token = data.token;
    elements.hostCode.textContent = data.code;
    setHostStatus("Waiting");
    elements.startHostBtn.disabled = true;
    elements.endHostBtn.disabled = false;
    addLog(elements.hostLog, `Host session ${data.code} is ready.`);

    const eventSource = new EventSource(buildEventSourceUrl(data.code, data.clientId, data.token));
    hostState.eventSource = eventSource;

    wireEventSource(eventSource, {
      connected: () => addLog(elements.hostLog, "Host channel connected."),
      feedState: (payload) => {
        replaceFeedEntries(hostState, payload.messages);
        renderHostFeed();
      },
      sessionEnded: (payload) => {
        addLog(elements.hostLog, `Session ended: ${payload.reason}`);
        cleanupHostSession();
      },
      sessionState: (payload) => {
        hostState.activeViewerId = payload.activeViewerId || null;
        hostState.pendingViewers = new Map(
          payload.viewers
            .filter((viewer) => viewer.status === "pending")
            .map((viewer) => [viewer.id, viewer])
        );
        renderPendingViewers();
      },
      signal: async (payload) => {
        if (!hostState.pc || payload.fromId !== hostState.activeViewerId) {
          return;
        }

        if (payload.signalType === "answer") {
          await hostState.pc.setRemoteDescription(payload.payload);
          addLog(elements.hostLog, "Viewer answer received.");
          return;
        }

        if (payload.signalType === "candidate") {
          await hostState.pc.addIceCandidate(payload.payload);
        }
      },
      textFeed: (payload) => {
        if (storeFeedEntry(hostState, payload)) {
          renderHostFeed();
        }

        if (payload.senderRole === "viewer") {
          addLog(elements.hostLog, "A new readable reply arrived from the viewer.");
        }
      },
      viewerLeft: (payload) => {
        hostState.pendingViewers.delete(payload.viewerId);
        if (hostState.activeViewerId === payload.viewerId) {
          destroyHostPeer();
          addLog(elements.hostLog, `Viewer left: ${payload.reason}`);
        }
        renderPendingViewers();
      },
      viewerRequest: (payload) => {
        hostState.pendingViewers.set(payload.viewerId, payload);
        renderPendingViewers();
        addLog(elements.hostLog, `Viewer requested access: ${payload.viewerId.slice(0, 12)}`);
      },
    });
  } catch (error) {
    addLog(elements.hostLog, `Unable to start host session: ${error.message}`);
  }
}

function cleanupHostSession() {
  hostState.eventSource?.close();
  hostState.eventSource = null;
  destroyHostPeer();

  if (hostState.stream) {
    for (const track of hostState.stream.getTracks()) {
      track.stop();
    }
    hostState.stream = null;
  }

  elements.localPreview.srcObject = null;
  hostState.clientId = null;
  hostState.code = null;
  hostState.token = null;
  resetHostUi();
}

async function leaveHostSession(sendRequest = true) {
  const payload = {
    clientId: hostState.clientId,
    code: hostState.code,
    token: hostState.token,
  };

  try {
    if (sendRequest && hostState.code) {
      await apiRequest("/api/leave", payload);
    }
  } catch (error) {
    addLog(elements.hostLog, `Host leave failed: ${error.message}`);
  } finally {
    cleanupHostSession();
  }
}

async function approveViewer(viewerId) {
  if (!hostState.code || !hostState.clientId) {
    return;
  }

  if (hostState.activeViewerId && hostState.activeViewerId !== viewerId) {
    addLog(elements.hostLog, "Only one active viewer is supported in this MVP.");
    return;
  }

  try {
    await ensureDisplayStream();
    await apiRequest("/api/decision", {
      approved: true,
      clientId: hostState.clientId,
      code: hostState.code,
      token: hostState.token,
      viewerId,
    });

    hostState.pendingViewers.delete(viewerId);
    renderPendingViewers();
    addLog(elements.hostLog, `Viewer approved: ${viewerId.slice(0, 12)}`);
    await buildHostPeer(viewerId);
    setHostStatus("Sharing");
  } catch (error) {
    addLog(elements.hostLog, `Approval failed: ${error.message}`);
  }
}

async function denyViewer(viewerId) {
  try {
    await apiRequest("/api/decision", {
      approved: false,
      clientId: hostState.clientId,
      code: hostState.code,
      token: hostState.token,
      viewerId,
    });
    hostState.pendingViewers.delete(viewerId);
    renderPendingViewers();
    addLog(elements.hostLog, `Viewer denied: ${viewerId.slice(0, 12)}`);
  } catch (error) {
    addLog(elements.hostLog, `Deny failed: ${error.message}`);
  }
}

async function joinViewerSession() {
  const code = normalizeCode(elements.viewerCodeInput.value);
  elements.viewerCodeInput.value = code;

  if (code.length !== 6) {
    addLog(elements.viewerLog, "Enter a six-digit session code.");
    return;
  }

  try {
    await loadRuntimeConfig();
    const data = await apiRequest("/api/join", { code });
    viewerState.code = data.code;
    viewerState.clientId = data.clientId;
    viewerState.token = data.token;
    viewerState.approved = false;
    setViewerStatus("Pending");
    elements.joinViewerBtn.disabled = true;
    elements.leaveViewerBtn.disabled = false;
    updateViewerFeedComposer();
    addLog(elements.viewerLog, `Join request sent for ${data.code}.`);

    const eventSource = new EventSource(buildEventSourceUrl(data.code, data.clientId, data.token));
    viewerState.eventSource = eventSource;

    wireEventSource(eventSource, {
      connected: () => addLog(elements.viewerLog, "Viewer channel connected."),
      joinApproved: (payload) => {
        viewerState.approved = true;
        replaceFeedEntries(viewerState, payload.messages);
        renderViewerFeed();
        updateViewerFeedComposer();
        setViewerStatus("Approved");
        addLog(elements.viewerLog, "The host approved your request.");
      },
      joinDenied: () => {
        addLog(elements.viewerLog, "The host denied your request.");
        cleanupViewerSession();
      },
      sessionEnded: (payload) => {
        addLog(elements.viewerLog, `Session ended: ${payload.reason}`);
        cleanupViewerSession();
      },
      signal: async (payload) => {
        if (payload.signalType === "offer") {
          const pc = buildViewerPeer(payload.fromId);
          await pc.setRemoteDescription(payload.payload);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await sendSignal(viewerState, payload.fromId, "answer", answer);
          setViewerStatus("Connected");
          addLog(elements.viewerLog, "Offer received and answered.");
          return;
        }

        if (payload.signalType === "candidate" && viewerState.pc) {
          await viewerState.pc.addIceCandidate(payload.payload);
        }
      },
      textFeed: (payload) => {
        if (storeFeedEntry(viewerState, payload)) {
          renderViewerFeed();
        }
      },
    });
  } catch (error) {
    addLog(elements.viewerLog, `Join failed: ${error.message}`);
    cleanupViewerSession();
  }
}

async function sendViewerFeed() {
  if (!viewerState.code || !viewerState.clientId || !viewerState.approved) {
    addLog(elements.viewerLog, "Wait for host approval before sending a reply.");
    return;
  }

  const text = getViewerFeedDraft();
  if (!text) {
    addLog(elements.viewerLog, "Type a short reply before sending.");
    return;
  }

  try {
    const data = await apiRequest("/api/feed", {
      clientId: viewerState.clientId,
      code: viewerState.code,
      text,
      token: viewerState.token,
    });

    storeFeedEntry(viewerState, data.entry);
    renderViewerFeed();
    elements.viewerFeedInput.value = "";
    updateViewerFeedComposer();
    addLog(elements.viewerLog, "Reply sent to the host screen.");
  } catch (error) {
    addLog(elements.viewerLog, `Reply failed: ${error.message}`);
  }
}

function cleanupViewerSession() {
  viewerState.eventSource?.close();
  viewerState.eventSource = null;
  destroyViewerPeer();
  viewerState.clientId = null;
  viewerState.code = null;
  viewerState.token = null;
  resetViewerUi();
}

async function leaveViewerSession(sendRequest = true) {
  const payload = {
    clientId: viewerState.clientId,
    code: viewerState.code,
    token: viewerState.token,
  };

  try {
    if (sendRequest && viewerState.code) {
      await apiRequest("/api/leave", payload);
    }
  } catch (error) {
    addLog(elements.viewerLog, `Viewer leave failed: ${error.message}`);
  } finally {
    cleanupViewerSession();
  }
}

elements.startHostBtn.addEventListener("click", startHostSession);
elements.endHostBtn.addEventListener("click", () => leaveHostSession(true));
elements.joinViewerBtn.addEventListener("click", joinViewerSession);
elements.leaveViewerBtn.addEventListener("click", () => leaveViewerSession(true));
elements.saveServerUrlBtn.addEventListener("click", async () => {
  await saveServerUrl(elements.serverUrlInput.value);
});
elements.useLocalServerBtn.addEventListener("click", async () => {
  await saveServerUrl(LOCAL_SERVER_URL);
});

elements.clearHostLogBtn.addEventListener("click", () => {
  elements.hostLog.innerHTML = "";
});

elements.clearViewerLogBtn.addEventListener("click", () => {
  elements.viewerLog.innerHTML = "";
});

elements.enableRemoteAudioBtn.addEventListener("click", () => {
  void tryPlayRemoteScreen();
});

elements.pendingList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) {
    return;
  }

  const viewerId = button.dataset.viewerId;
  if (!viewerId) {
    return;
  }

  if (button.dataset.action === "approve") {
    await approveViewer(viewerId);
    return;
  }

  if (button.dataset.action === "deny") {
    await denyViewer(viewerId);
  }
});

elements.viewerCodeInput.addEventListener("input", () => {
  elements.viewerCodeInput.value = normalizeCode(elements.viewerCodeInput.value);
});

elements.viewerFeedInput.addEventListener("input", () => {
  if (elements.viewerFeedInput.value.length > FEED_TEXT_MAX_LENGTH) {
    elements.viewerFeedInput.value = elements.viewerFeedInput.value.slice(0, FEED_TEXT_MAX_LENGTH);
  }
  updateViewerFeedComposer();
});

elements.sendViewerFeedBtn.addEventListener("click", sendViewerFeed);

elements.viewerFeedInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void sendViewerFeed();
  }
});

window.addEventListener("beforeunload", () => {
  hostState.eventSource?.close();
  viewerState.eventSource?.close();
});

elements.serverUrlInput.value = connectionState.serverUrl;
resetHostUi();
resetViewerUi();
updateViewerPlaceholder();
renderHostFeed();
renderViewerFeed();
loadRuntimeConfig().catch(() => {});
