const { app, BrowserWindow } = require('electron');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', 'backend', '.env') });
const RecallAiSdk = require('@recallai/desktop-sdk');

function normalizeRecallApiBase(value) {
  const fallback = "https://us-west-2.recall.ai";
  const raw = (value || fallback).trim();
  const unquoted = raw.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");

  try {
    const url = new URL(unquoted);

    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch (_error) {
    return fallback;
  }
}

const RECALL_API_BASE = normalizeRecallApiBase(process.env.RECALL_API_BASE);

RecallAiSdk.init({
  apiUrl: RECALL_API_BASE
});

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const BACKEND_API_BASE = "http://localhost:3000";

const recordingIdByWindowId = new Map();
const recordingMetaById = new Map();

function maskToken(token) {
  if (!token || typeof token !== "string") return null;
  if (token.length <= 8) return `${token.slice(0, 2)}...${token.slice(-2)}`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

let mainWindow;

function emitStatus(payload) {
  mainWindow?.webContents.send("status:changed", payload);
}

async function requestPermissionWithLog(permission) {
  try {
    const result = await RecallAiSdk.requestPermission(permission);
    console.log(`Permission ${permission}:`, result);
    return result;
  } catch (error) {
    console.error(`Permission ${permission} failed:`, error);
    return null;
  }
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // recommended
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  createWindow();

  requestPermissionWithLog("accessibility");
  requestPermissionWithLog("microphone");
  requestPermissionWithLog("system-audio");
  requestPermissionWithLog("screen-capture");
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

const createSdkRecording = async () => {
  const res = await fetch(`${BACKEND_API_BASE}/api/create_sdk_recording`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });

  const text = await res.text();
  let payload = null;

  try {
    payload = text ? JSON.parse(text) : null;
  } catch (parseError) {
    throw new Error(`Backend returned non-JSON response: ${text || "(empty body)"}`);
  }

  if (!res.ok) {
    throw new Error(`Backend ${res.status}: ${JSON.stringify(payload)}`);
  }

  return payload;
};

async function waitForTranscriptUrl(recordingId, { intervalMs = 3000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BACKEND_API_BASE}/api/transcript_for_recording/${recordingId}`);
    if (res.status === 409) { await sleep(intervalMs); continue; }

    const text = await res.text();
    if (!res.ok) throw new Error(`backend ${res.status}: ${text}`);

    const data = JSON.parse(text);
    return data.transcript_download_url;
  }
  throw new Error("Timed out waiting for transcript url");
}

const startRecording = async (windowId, uploadToken) => {
  await RecallAiSdk.startRecording({
    windowId: windowId,
    uploadToken: uploadToken
  });
}

RecallAiSdk.addEventListener("meeting-detected", async (evt) => {
  try {
    console.log("meeting-detected", evt);
    console.log("Recall config", { apiUrl: RECALL_API_BASE, backendApiBase: BACKEND_API_BASE });
    emitStatus({
      phase: "Listening",
      title: "Meeting detected and recording started",
      description: "Cliff is attached to the meeting window and capturing audio in the background.",
    });

    const payload = await createSdkRecording();
    console.log("payload", payload);

    const upload_token = payload?.upload_token;
    const recordingId = payload?.recording_id;

    console.log("create_sdk_recording payload summary", {
      hasUploadToken: Boolean(upload_token),
      uploadTokenPreview: maskToken(upload_token),
      uploadTokenLength: upload_token?.length ?? null,
      recordingId: recordingId ?? null,
    });

    if (!upload_token) throw new Error("Missing upload_token from backend");
    if (!recordingId) throw new Error("Missing payload.recording_id (recording_id) from backend");

    const windowId = evt.window.id;
    recordingIdByWindowId.set(windowId, recordingId);
    recordingMetaById.set(recordingId, { startedAt: new Date().toISOString() });

    await startRecording(windowId, upload_token);

    console.log(`Started recording for window ${windowId}`);
    console.log(`Upload token preview: ${maskToken(upload_token)}`);
    console.log(`Recording ID: ${recordingId}`);
  } catch (error) {
    console.error("meeting-detected failed:", error);
    emitStatus({
      phase: "Error",
      title: "Cliff could not start this meeting",
      description: error?.message ?? "Recording setup failed before capture began.",
      tone: "danger",
    });
  }
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForAudioUrl(recordingId, { intervalMs = 5000, timeoutMs = 120000 } = {}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BACKEND_API_BASE}/api/audio_for_recording/${recordingId}`);

      if (res.status === 409) {
        await sleep(intervalMs);
        continue;
      }

      const text = await res.text();
      if (!res.ok) throw new Error(`backend ${res.status}: ${text}`);

      const data = JSON.parse(text);
      const audioUrl = data?.audio_download_url ?? null;
      if (audioUrl) return audioUrl;
    } catch (e) {
      console.log("Polling...", e?.message ?? String(e));
    }

    await sleep(intervalMs);
  }

  throw new Error("Timed out waiting for audio_mixed.done / audio url");
}

function wordsToText(words) {
  const punct = new Set([",", ".", "!", "?", ":", ";", ")", "]", "}", "%"]);
  const open = new Set(["(", "[", "{", "“", "\"", "‘", "'"]);
  let out = "";

  for (const w of words) {
    const t = w?.text ?? "";
    if (!t) continue;
    if (!out) { out = t; continue; }

    const lastChar = out[out.length - 1];
    if (punct.has(t)) { out += t; continue; }
    if (open.has(lastChar)) { out += t; continue; }

    out += " " + t;
  }

  return out
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .trim();
}

function cleanTranscriptParts(parts, { mergeGapSeconds = 1.25 } = {}) {
  const utterances = [];

  for (const part of parts || []) {
    const speaker = part?.participant?.name ?? "Unknown";
    const words = Array.isArray(part?.words) ? part.words : [];
    if (!words.length) continue;

    const start = words[0]?.start_timestamp?.relative ?? null;
    const end = words[words.length - 1]?.end_timestamp?.relative ?? null;
    const text = wordsToText(words);
    if (!text) continue;

    const prev = utterances[utterances.length - 1];
    if (
      prev &&
      prev.speaker === speaker &&
      prev.end != null &&
      start != null &&
      (start - prev.end) <= mergeGapSeconds
    ) {
      prev.text = (prev.text + " " + text).trim();
      prev.end = end;
    } else {
      utterances.push({ speaker, start, end, text });
    }
  }

  return utterances;
}

RecallAiSdk.addEventListener("recording-ended", async (evt) => {
  try {
    console.log("Meeting has ended");
    emitStatus({
      phase: "Processing",
      title: "Meeting ended, processing notes",
      description: "Cliff is retrieving the audio and transcript for this session.",
    });

    const windowId = evt.window.id;
    const recordingId = recordingIdByWindowId.get(windowId);
    if (!recordingId) throw new Error(`No recordingId for windowId=${windowId}`);

    const audioUrl = await waitForAudioUrl(recordingId);
    console.log("Audio URL ready:", audioUrl);

    const transcriptUrl = await waitForTranscriptUrl(recordingId);
    console.log("Transcript URL ready:", transcriptUrl);

    const transcriptRes = await fetch(transcriptUrl);
    const transcriptText = await transcriptRes.text();
    if (!transcriptRes.ok) {
      throw new Error(`transcript download ${transcriptRes.status}: ${transcriptText}`);
    }

    console.log("Transcript raw preview:", transcriptText.slice(0, 500));

    let parts = [];
    try {
      parts = transcriptText ? JSON.parse(transcriptText) : [];
    } catch (error) {
      throw new Error(`Transcript JSON parse failed: ${error?.message ?? String(error)}`);
    }

    console.log("Transcript payload shape:", {
      isArray: Array.isArray(parts),
      topLevelType: typeof parts,
      itemCount: Array.isArray(parts) ? parts.length : null,
    });

    const utterances = cleanTranscriptParts(parts);
    console.log("Transcript processing summary:", {
      partsCount: Array.isArray(parts) ? parts.length : 0,
      utterancesCount: utterances.length,
      firstUtterance: utterances[0] ?? null,
    });

    if (!utterances.length) {
      console.warn("Transcript contained no utterances. Skipping summarize step.");
      const meta = recordingMetaById.get(recordingId);
      const endedAt = new Date().toISOString();
      mainWindow?.webContents.send("audioUrl:ready", {
        recordingId,
        audioUrl,
        startedAt: meta?.startedAt ?? null,
        endedAt,
      });
      mainWindow?.webContents.send("transcript:ready", {
        recordingId,
        utterances: [],
        startedAt: meta?.startedAt ?? null,
        endedAt,
      });
      emitStatus({
        phase: "Ready",
        title: "Meeting notes are ready",
        description: "Participants, recording link, and transcript have been prepared.",
      });
      recordingMetaById.delete(recordingId);
      recordingIdByWindowId.delete(windowId);
      return;
    }

    const meta = recordingMetaById.get(recordingId);
    const endedAt = new Date().toISOString();
    mainWindow?.webContents.send("audioUrl:ready", {
      recordingId,
      audioUrl,
      startedAt: meta?.startedAt ?? null,
      endedAt,
    });
    mainWindow?.webContents.send("transcript:ready", {
      recordingId,
      utterances,
      startedAt: meta?.startedAt ?? null,
      endedAt,
    });
    emitStatus({
      phase: "Ready",
      title: "Meeting notes are ready",
      description: "Participants, recording link, and transcript have been prepared.",
    });

    recordingMetaById.delete(recordingId);
    recordingIdByWindowId.delete(windowId);
  } catch (e) {
    console.error("recording-ended failed:", e);
    emitStatus({
      phase: "Error",
      title: "Something interrupted processing",
      description: e?.message ?? "Cliff could not finish preparing this meeting.",
      tone: "danger",
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
