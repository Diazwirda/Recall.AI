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

const stepEls = {
  detect: document.getElementById("stepDetect"),
  record: document.getElementById("stepRecord"),
  process: document.getElementById("stepProcess"),
  done: document.getElementById("stepDone"),
};

const state = {
  phase: "idle",
  videoUrl: "",
  utterances: [],
  participants: [],
};

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

function refreshView() {
  const hasContent = Boolean(state.utterances.length || state.videoUrl);
  showContent(hasContent);
  renderParticipants(state.participants);
  renderLink(state.videoUrl);
  renderTranscript(state.utterances);
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

window.cliff.onVideoReady(({ videoUrl }) => {
  state.videoUrl = videoUrl || "";
  refreshView();
});

window.cliff.onTranscriptReady(({ utterances }) => {
  state.utterances = Array.isArray(utterances) ? utterances : [];
  state.participants = collectParticipants(state.utterances);
  refreshView();
});

setIdleState();
refreshView();
