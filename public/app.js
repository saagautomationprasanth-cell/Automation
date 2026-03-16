let rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

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
  pc: null,
  pendingViewers: new Map(),
  stream: null,
  token: null,
};

const viewerState = {
  clientId: null,
  code: null,
  eventSource: null,
  hostId: null,
  pc: null,
  remoteStream: null,
  token: null,
};

const elements = {
  currentServerLabel: document.getElementById("currentServerLabel"),
  clearHostLogBtn: document.getElementById("clearHostLogBtn"),
  clearViewerLogBtn: document.getElementById("clearViewerLogBtn"),
  endHostBtn: document.getElementById("endHostBtn"),
  hostCode: document.getElementById("hostCode"),
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
  startHostBtn: document.getElementById("startHostBtn"),
  serverUrlInput: document.getElementById("serverUrlInput"),
  useLocalServerBtn: document.getElementById("useLocalServerBtn"),
  viewerCodeInput: document.getElementById("viewerCodeInput"),
  viewerLog: document.getElementById("viewerLog"),
  viewerPlaceholder: document.getElementById("viewerPlaceholder"),
  viewerStatus: document.getElementById("viewerStatus"),
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
    ["join-approved", handlers.joinApproved],
    ["join-denied", handlers.joinDenied],
    ["ping", handlers.ping],
    ["session-ended", handlers.sessionEnded],
    ["session-state", handlers.sessionState],
    ["signal", handlers.signal],
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

  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: false,
    video: {
      frameRate: { ideal: 12, max: 15 },
    },
  });

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
  elements.remoteScreen.srcObject = null;
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
    viewerState.remoteStream = remoteStream;
    elements.remoteScreen.srcObject = remoteStream;
    updateViewerPlaceholder();
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
  renderPendingViewers();
}

function resetViewerUi() {
  setViewerStatus("Idle");
  elements.joinViewerBtn.disabled = false;
  elements.leaveViewerBtn.disabled = true;
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
    setHostStatus("Sharing");
    addLog(elements.hostLog, `Viewer approved: ${viewerId.slice(0, 12)}`);
    await buildHostPeer(viewerId);
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
    setViewerStatus("Pending");
    elements.joinViewerBtn.disabled = true;
    elements.leaveViewerBtn.disabled = false;
    addLog(elements.viewerLog, `Join request sent for ${data.code}.`);

    const eventSource = new EventSource(buildEventSourceUrl(data.code, data.clientId, data.token));
    viewerState.eventSource = eventSource;

    wireEventSource(eventSource, {
      connected: () => addLog(elements.viewerLog, "Viewer channel connected."),
      joinApproved: () => {
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
    });
  } catch (error) {
    addLog(elements.viewerLog, `Join failed: ${error.message}`);
    cleanupViewerSession();
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

window.addEventListener("beforeunload", () => {
  hostState.eventSource?.close();
  viewerState.eventSource?.close();
});

elements.serverUrlInput.value = connectionState.serverUrl;
resetHostUi();
resetViewerUi();
updateViewerPlaceholder();
loadRuntimeConfig().catch(() => {});
