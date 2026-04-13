// server.js
const express = require("express");
const app = express();
require('dotenv').config();

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
const RECALL_API_KEY = process.env.RECALL_API_KEY;
app.use(express.json()); // lets you read JSON bodies

function maskToken(token) {
  if (!token || typeof token !== "string") return null;
  if (token.length <= 8) return `${token.slice(0, 2)}...${token.slice(-2)}`;
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

const completedRecordings = new Set(); // sdk_upload.complete seen
const completedAudioMixedRecordings = new Set(); // audio_mixed.done seen
const transcriptStateByRecordingId = new Map();
// recordingId -> { status: "starting" | "processing" | "complete" | "failed", transcriptId?: string, error?: string }

const transcriptCache = new Map(); // transcriptId -> retrieved transcript object

async function createTranscript(recordingId) {
const url = `${RECALL_API_BASE}/api/v1/recording/${recordingId}/create_transcript/`;
console.log("createTranscript URL:", url);
const res = await fetch(url, {
  method: "POST",
  headers: {
  accept: "application/json",
  "content-type": "application/json",
  Authorization: `Token ${RECALL_API_KEY}`,
  },
  body: JSON.stringify({
    provider: {
      recallai_async: {
        language_code: "auto"
      }
    }
  })
}); 

if (!res.ok) {
const text = await res.text();
throw new Error(`create_transcript ${res.status}: ${text}`);
}
return res.json();
}  

// IMPORTANT: For signature verification you often need the raw body,
// but start simple first, then harden with verification.
app.post("/webhooks/recall", express.json(), async (req, res) => {
  const evt = req.body;
  const eventName = evt?.event;
  const data = evt?.data ?? {};

  const recordingId = data?.recording_id
    ? String(data.recording_id)
    : data?.recording?.id
      ? String(data.recording.id)
      : null;
  const transcriptId = data?.transcript_id
    ? String(data.transcript_id)
    : data?.transcript?.id
      ? String(data.transcript.id)
      : null;

  console.log("webhook:", eventName, { recordingId, transcriptId });

  const isUploadDone =
    eventName === "sdk_upload.complete" || eventName === "sdk_upload.completed";

  if (eventName === "audio_mixed.done" && recordingId) {
    completedAudioMixedRecordings.add(recordingId);
  }

  if (isUploadDone && recordingId) {
    completedRecordings.add(recordingId);

    if (!transcriptStateByRecordingId.has(recordingId)) {
      transcriptStateByRecordingId.set(recordingId, { status: "starting" });

      try {
        console.log("SDK upload complete, creating transcript job for:", recordingId);
        const job = await createTranscript(recordingId);
        const createdTranscriptId = job?.id ?? job?.transcript?.id ?? null;

        transcriptStateByRecordingId.set(recordingId, {
          status: "processing",
          transcriptId: createdTranscriptId ? String(createdTranscriptId) : undefined,
        });
      } catch (e) {
        transcriptStateByRecordingId.set(recordingId, {
          status: "failed",
          error: e?.message ?? String(e),
        });
        console.error("createTranscript failed:", e);
      }
    }
  }

  if (eventName === "transcript.done" && recordingId && transcriptId) {
    try {
      const tRes = await fetch(`${RECALL_API_BASE}/api/v1/transcript/${transcriptId}/`, {
        headers: {
          accept: "application/json",
          Authorization: `Token ${RECALL_API_KEY}`,
        },
      });

      const tText = await tRes.text();
      if (!tRes.ok) {
        console.error("transcript retrieve failed:", tRes.status, tText);
      } else {
        const transcript = JSON.parse(tText);
        transcriptCache.set(transcriptId, transcript);

        transcriptStateByRecordingId.set(recordingId, {
          status: "complete",
          transcriptId,
        });
      }
    } catch (e) {
      transcriptStateByRecordingId.set(recordingId, {
        status: "failed",
        transcriptId,
        error: e?.message ?? String(e),
      });
      console.error("transcript retrieve failed:", e);
    }
  }

  if (eventName === "transcript.failed" && recordingId) {
    transcriptStateByRecordingId.set(recordingId, {
      status: "failed",
      transcriptId: transcriptId ?? undefined,
      error: evt?.data?.data?.sub_code ?? "transcript.failed",
    });
  }

  res.sendStatus(200);
});

app.get("/api/transcript_for_recording/:recordingId", (req, res) => {
  const recordingId = String(req.params.recordingId);
  if (!recordingId) {
    return res.status(400).json({ error: "Missing recordingId" });
  }

  // Step 1: wait for upload completion
  if (!completedRecordings.has(recordingId)) {
    return res.status(409).json({ status: "processing_upload" });
  }

  // Step 2: wait for transcript creation / processing
  const state = transcriptStateByRecordingId.get(recordingId);
  if (!state) {
    return res.status(409).json({ status: "creating_transcript" });
  }

  if (state.status === "failed") {
    return res.status(500).json({
      status: "transcript_failed",
      error: state.error ?? "unknown",
      transcript_id: state.transcriptId ?? null,
    });
  }

  if (state.status !== "complete") {
    return res.status(409).json({
      status: "processing_transcript",
      transcript_id: state.transcriptId ?? null,
    });
  }

  // Step 3: return the retrieved transcript artifact
  const transcript = state.transcriptId ? transcriptCache.get(state.transcriptId) : null;
  if (!transcript) {
    return res.status(409).json({
      status: "processing_transcript",
      transcript_id: state.transcriptId ?? null,
    });
  }

  return res.json({
    status: "complete",
    recording_id: recordingId,
    transcript_id: state.transcriptId,
    transcript_download_url: transcript?.data?.download_url ?? null,
  });
});

app.post("/api/create_sdk_recording", async (req, res) => {
    console.log("HIT /api/create_sdk_recording");

    try {
      if (!RECALL_API_KEY) {
        return res.status(500).json({ error: "Missing RECALL_API_KEY env var" });
      }
      console.log("Calling Recall:", `${RECALL_API_BASE}/api/v1/sdk_upload/`, {
        recallApiBase: RECALL_API_BASE,
        recallApiKeyPreview: maskToken(RECALL_API_KEY),
      });

      const recallRes = await fetch(`${RECALL_API_BASE}/api/v1/sdk_upload/`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${RECALL_API_KEY}`,
          'Content-Type': 'application/json',
          accept: "application/json",
        },
        body: JSON.stringify({
          recording_config: {
            video_mixed_mp4: null,
            audio_mixed_mp3: {}
          }
        })
      });
      console.log("Recall status:", recallRes.status);

      const text = await recallRes.text();
      console.log("Recall raw response:", text);

      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (parseError) {
        console.error("Recall response was not valid JSON:", parseError);
      }

      if (!recallRes.ok) {
        return res.status(recallRes.status).json({
          error: "Recall API request failed",
          recall_status: recallRes.status,
          recall_api_base: RECALL_API_BASE,
          recall_response: payload ?? text ?? null,
        });
      }

      console.log("Recall sdk_upload payload summary:", {
        hasUploadToken: Boolean(payload?.upload_token),
        uploadTokenPreview: maskToken(payload?.upload_token),
        uploadTokenLength: payload?.upload_token?.length ?? null,
        recordingId: payload?.recording_id ?? null,
      });

      if (!payload?.upload_token || !payload?.recording_id) {
        return res.status(502).json({
          error: "Recall API response missing required fields",
          recall_api_base: RECALL_API_BASE,
          recall_response: payload ?? text ?? null,
        });
      }

      return res.json(payload);
    } catch (err) {
      console.error("create_sdk_recording failed:", err);
      const cause = err?.cause;
      return res.status(500).json({
        error: err?.message ?? String(err),
        recall_api_base: RECALL_API_BASE,
        cause: cause
          ? {
              code: cause.code ?? null,
              syscall: cause.syscall ?? null,
              hostname: cause.hostname ?? null,
              message: cause.message ?? String(cause),
            }
          : null,
      });
    }
  });

app.get("/api/sdk_upload/:id", async (req, res) => {
    const id = req.params.id;

    const recallRes = await fetch(`${RECALL_API_BASE}/api/v1/sdk_upload/${id}/`, {
        headers: { Authorization: `Token ${RECALL_API_KEY}`, accept: "application/json" },
    });

    const text = await recallRes.text();
    if (!recallRes.ok) return res.status(recallRes.status).send(text);

    res.json(JSON.parse(text));
});

app.get("/api/recording/:recordingId", async (req, res) => {
  const recordingId = String(req.params.recordingId);
  if (!recordingId) {
    return res.status(400).json({ error: "Missing recordingId" });
  }

  // Wait until sdk_upload.complete webhook has arrived for this recording
  if (!completedRecordings.has(recordingId)) {
    return res.status(409).json({ status: "processing_upload", recording_id: recordingId });
  }

  try {
    const recRes = await fetch(`${RECALL_API_BASE}/api/v1/recording/${recordingId}/`, {
      headers: {
        accept: "application/json",
        Authorization: `Token ${RECALL_API_KEY}`,
      },
    });

    const recText = await recRes.text();
    if (!recRes.ok) return res.status(recRes.status).send(recText);

    return res.json(JSON.parse(recText));
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

app.get("/api/audio_for_recording/:recordingId", async (req, res) => {
  const recordingId = String(req.params.recordingId);
  if (!recordingId) {
    return res.status(400).json({ error: "Missing recordingId" });
  }

  if (!completedAudioMixedRecordings.has(recordingId)) {
    return res.status(409).json({ status: "processing_audio", recording_id: recordingId });
  }

  try {
    const audioRes = await fetch(`${RECALL_API_BASE}/api/v1/audio_mixed?recording_id=${recordingId}`, {
      headers: {
        accept: "application/json",
        Authorization: `Token ${RECALL_API_KEY}`,
      },
    });

    const audioText = await audioRes.text();
    if (!audioRes.ok) return res.status(audioRes.status).send(audioText);

    const payload = JSON.parse(audioText);
    const audio = Array.isArray(payload?.results) ? payload.results[0] : null;
    const audioUrl = audio?.data?.download_url ?? null;

    if (!audioUrl) {
      return res.status(409).json({
        status: "processing_audio",
        recording_id: recordingId,
      });
    }

    return res.json({
      status: "complete",
      recording_id: recordingId,
      audio_download_url: audioUrl,
      audio_id: audio?.id ?? null,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Recall API base:", RECALL_API_BASE);
  console.log(`Server running on http://localhost:${PORT}`);
});
