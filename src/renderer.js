const transcriptEl = document.getElementById("transcript");
const participantsTextEl = document.getElementById("participantsText");
const participantsListEl = document.getElementById("participantsList");
const videoLinkEl = document.getElementById("videoLink");
const emptyStateEl = document.getElementById("emptyState");
const contentGridEl = document.getElementById("contentGrid");
const statusPillEl = document.getElementById("statusPill");
const statusTitleEl = document.getElementById("statusTitle");
const statusDescriptionEl = document.getElementById("statusDescription");
const participantCountEl = document.getElementById("participantCount");
const recordingStateEl = document.getElementById("recordingState");
const openRecordingLinkEl = document.getElementById("openRecordingLink");
const historyListEl = document.getElementById("historyList");
const historyEmptyEl = document.getElementById("historyEmpty");

const stepEls = {
  detect: document.getElementById("stepDetect"),
  record: document.getElementById("stepRecord"),
  process: document.getElementById("stepProcess"),
  done: document.getElementById("stepDone"),
};

const HISTORY_STORAGE_KEY = "cliff:recordingHistory";
const pendingRecordings = new Map();

const state = {
  phase: "idle",
  recordingUrl: "",
  utterances: [],
  participants: [],
  history: [],
};

function loadHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function saveHistory(items) {
  try {
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(items));
  } catch (_error) {
    // Ignore storage failures (quota, blocked storage, etc.)
  }
}

function setStepState(activeKey) {
  const order = ["detect", "record", "process", "done"];
  const activeIndex = order.indexOf(activeKey);

  for (const [key, el] of Object.entries(stepEls)) {
    const index = order.indexOf(key);
    el.classList.toggle("is-active", key === activeKey);
    el.classList.toggle("is-complete", activeIndex > index);
  }
}

function setStatus(phase, title, description, tone = "default") {
  state.phase = phase;
  statusPillEl.textContent = phase;
  statusPillEl.classList.toggle("is-warning", tone === "warning");
  statusPillEl.classList.toggle("is-danger", tone === "danger");
  statusTitleEl.textContent = title;
  statusDescriptionEl.textContent = description;
}

function showContent(show) {
  emptyStateEl.classList.toggle("is-hidden", show);
  contentGridEl.classList.toggle("is-hidden", !show);
}

function updateSnapshot() {
  participantCountEl.textContent = `${state.participants.length} ${state.participants.length === 1 ? "person" : "people"}`;

  if (state.phase === "Idle") {
    recordingStateEl.textContent = "Not started";
  } else if (state.phase === "Listening") {
    recordingStateEl.textContent = "Recording in progress";
  } else if (state.phase === "Processing") {
    recordingStateEl.textContent = "Meeting captured";
  } else if (state.phase === "Ready") {
    recordingStateEl.textContent = "Completed";
  } else {
    recordingStateEl.textContent = "Attention needed";
  }

}

function collectParticipants(utterances) {
  const seen = new Set();
  const speakers = [];

  for (const utterance of utterances) {
    const name = utterance?.speaker ?? "Unknown";
    if (!seen.has(name)) {
      seen.add(name);
      speakers.push(name);
    }
  }

  return speakers;
}

function renderParticipants(participants) {
  participantsListEl.innerHTML = "";

  for (const person of participants) {
    const chip = document.createElement("span");
    chip.className = "participant-chip";
    chip.textContent = person;
    participantsListEl.appendChild(chip);
  }

  participantsTextEl.textContent = participants.length
    ? `Cliff identified ${participants.length} participant${participants.length === 1 ? "" : "s"} in this meeting.`
    : "No participant names were detected in the transcript yet.";
}

function renderLink(url) {
  videoLinkEl.innerHTML = "";

  if (!url) {
    openRecordingLinkEl.setAttribute("aria-disabled", "true");
    openRecordingLinkEl.href = "#";
    videoLinkEl.textContent = "No recording link yet.";
    return;
  }

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noreferrer";
  anchor.textContent = "Open recording asset";
  videoLinkEl.appendChild(anchor);

  openRecordingLinkEl.href = url;
  openRecordingLinkEl.setAttribute("aria-disabled", "false");
}

function formatTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function makeTitle(participants, endedAt) {
  if (participants.length === 1) {
    return `Meeting with ${participants[0]}`;
  }
  if (participants.length === 2) {
    return `Meeting with ${participants[0]} & ${participants[1]}`;
  }
  if (participants.length > 2) {
    return `Meeting with ${participants[0]} +${participants.length - 1}`;
  }
  const dateLabel = formatDate(endedAt) || "today";
  return `Meeting on ${dateLabel}`;
}

function getPendingRecording(recordingId) {
  if (!recordingId) return null;
  if (!pendingRecordings.has(recordingId)) {
    pendingRecordings.set(recordingId, { recordingId });
  }
  return pendingRecordings.get(recordingId);
}

function addToHistory(entry) {
  if (!entry?.recordingId) return;
  if (state.history.some((item) => item.recordingId === entry.recordingId)) {
    return;
  }
  state.history = [entry, ...state.history].slice(0, 30);
  saveHistory(state.history);
}

function finalizeHistoryEntry(recordingId) {
  const pending = pendingRecordings.get(recordingId);
  if (!pending) return;
  if (!pending.audioUrl || !pending.title || !pending.endedAt) return;
  addToHistory(pending);
  pendingRecordings.delete(recordingId);
}

function renderTranscript(utterances) {
  transcriptEl.innerHTML = "";

  for (const utterance of utterances) {
    const line = document.createElement("article");
    line.className = "line";

    const speaker = document.createElement("span");
    speaker.className = "line-speaker";
    speaker.textContent = `${utterance.speaker ?? "Unknown"}`;

    const text = document.createElement("p");
    text.className = "line-text";
    text.textContent = utterance.text ?? "";

    line.appendChild(speaker);
    line.appendChild(text);
    transcriptEl.appendChild(line);
  }
}

function renderHistory(items) {
  historyListEl.innerHTML = "";

  if (!items.length) {
    historyEmptyEl.classList.remove("is-hidden");
    return;
  }

  historyEmptyEl.classList.add("is-hidden");

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "history-item";

    const meta = document.createElement("div");
    meta.className = "history-meta";

    const title = document.createElement("strong");
    title.className = "history-title";
    title.textContent = item.title || "Meeting recording";

    const time = document.createElement("span");
    time.className = "history-time";
    const timeText = formatTime(item.endedAt || item.startedAt);
    const dateText = formatDate(item.endedAt || item.startedAt);
    time.textContent = timeText && dateText ? `${timeText} · ${dateText}` : timeText || dateText || "";

    meta.appendChild(title);
    meta.appendChild(time);

    const linkWrap = document.createElement("div");
    linkWrap.className = "history-link";

    if (item.audioUrl) {
      const link = document.createElement("a");
      link.href = item.audioUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Open audio";
      linkWrap.appendChild(link);
    } else {
      linkWrap.textContent = "Audio link unavailable";
    }

    row.appendChild(meta);
    row.appendChild(linkWrap);
    historyListEl.appendChild(row);
  }
}

function refreshView() {
  const hasContent = Boolean(state.utterances.length || state.recordingUrl || state.history.length);
  showContent(hasContent);
  renderParticipants(state.participants);
  renderLink(state.recordingUrl);
  renderTranscript(state.utterances);
  renderHistory(state.history);
  updateSnapshot();
}

function setIdleState() {
  setStatus(
    "Idle",
    "Ready to capture your next meeting",
    "Cliff will listen for a supported meeting window and prepare notes automatically."
  );
  setStepState("detect");
  updateSnapshot();
}

window.cliff.onStatusChanged(({ phase, title, description, tone }) => {
  setStatus(phase, title, description, tone);

  if (phase === "Listening") {
    setStepState("record");
  } else if (phase === "Processing") {
    setStepState("process");
  } else if (phase === "Ready") {
    setStepState("done");
  } else if (phase === "Error") {
    setStepState("process");
  } else {
    setStepState("detect");
  }

  updateSnapshot();
});

window.cliff.onVideoReady((payload) => {
  const { videoUrl, audioUrl, recordingId, endedAt, startedAt } = payload || {};
  const resolvedUrl = videoUrl || audioUrl || "";
  state.recordingUrl = resolvedUrl;

  const pending = getPendingRecording(recordingId);
  if (pending) {
    pending.audioUrl = resolvedUrl;
    pending.endedAt = endedAt || new Date().toISOString();
    if (startedAt) pending.startedAt = startedAt;
    if (!pending.title) {
      pending.title = makeTitle(pending.participants || [], pending.endedAt);
    }
    finalizeHistoryEntry(recordingId);
  }
  refreshView();
});

window.cliff.onTranscriptReady((payload) => {
  const { utterances, recordingId, endedAt, startedAt } = payload || {};
  state.utterances = Array.isArray(utterances) ? utterances : [];
  state.participants = collectParticipants(state.utterances);
  const pending = getPendingRecording(recordingId);
  if (pending) {
    pending.participants = state.participants;
    pending.title = makeTitle(state.participants, endedAt || pending.endedAt);
    pending.endedAt = endedAt || pending.endedAt;
    if (startedAt) pending.startedAt = startedAt;
    finalizeHistoryEntry(recordingId);
  }
  refreshView();
});

state.history = loadHistory();
setIdleState();
refreshView();
