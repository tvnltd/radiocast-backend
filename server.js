const express = require("express");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());

// CORS — allow requests from any origin (Goodbarber, localhost, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Optional simple API key auth — set API_KEY env var in Railway to enable
const API_KEY = process.env.API_KEY || null;
function checkAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["authorization"] || req.query.key;
  if (key !== API_KEY && key !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

let ffmpegProcess = null;
let streamStatus = "idle";
let streamLogs = [];
let currentConfig = null;

function log(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg: String(msg).slice(0, 500), type };
  streamLogs.push(entry);
  if (streamLogs.length > 300) streamLogs = streamLogs.slice(-300);
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function killFFmpeg() {
  if (ffmpegProcess) {
    try { ffmpegProcess.kill("SIGKILL"); } catch (_) {}
    ffmpegProcess = null;
  }
}

// ── Start ──
app.post("/api/start", checkAuth, (req, res) => {
  const {
    inputUrl, rtmpUrl, streamKey,
    videoBitrate = "500k", audioBitrate = "128k",
    showLogo = false, logoText = ""
  } = req.body;

  if (!inputUrl || !rtmpUrl || !streamKey)
    return res.status(400).json({ error: "inputUrl, rtmpUrl and streamKey are required" });

  if (ffmpegProcess)
    return res.status(409).json({ error: "A stream is already running. Stop it first." });

  const rtmpTarget = rtmpUrl.replace(/\/$/, "") + "/" + streamKey;
  currentConfig = { inputUrl, rtmpUrl, streamKey, videoBitrate, audioBitrate };
  streamLogs = [];
  streamStatus = "connecting";

  log(`Starting: ${inputUrl} → ${rtmpTarget}`);

  const args = [
    "-re",
    "-i", inputUrl,
    "-f", "lavfi", "-i", "color=c=black:size=1280x720:rate=30",
    "-map", "1:v", "-map", "0:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "stillimage",
    "-b:v", videoBitrate, "-maxrate", videoBitrate, "-bufsize", "1000k",
    "-g", "60", "-r", "30",
  ];

  if (showLogo && logoText) {
    const safe = logoText.replace(/'/g, "\\'").replace(/:/g, "\\:");
    args.push("-vf", `drawtext=text='${safe}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=10`);
  }

  args.push(
    "-c:a", "aac", "-b:a", audioBitrate, "-ar", "44100", "-ac", "2",
    "-f", "flv", rtmpTarget
  );

  ffmpegProcess = spawn("ffmpeg", args);

  ffmpegProcess.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (!text) return;
    if (/frame=|fps=|bitrate=|speed=/.test(text)) {
      log(text, "progress");
    } else {
      log(text, "ffmpeg");
      if (/Connection refused|No such file|Invalid data|error/i.test(text)) streamStatus = "error";
      else if (/Stream mapping|Output #0/i.test(text)) streamStatus = "live";
    }
  });

  ffmpegProcess.on("close", (code) => {
    log(`FFmpeg exited (code ${code})`, code === 0 ? "info" : "error");
    streamStatus = code === 0 ? "idle" : "error";
    ffmpegProcess = null;
  });

  ffmpegProcess.on("error", (err) => {
    log(`Failed to spawn FFmpeg: ${err.message}`, "error");
    streamStatus = "error";
    ffmpegProcess = null;
  });

  setTimeout(() => { if (ffmpegProcess && streamStatus === "connecting") streamStatus = "live"; }, 4000);

  res.json({ ok: true, message: "Stream starting…" });
});

// ── Stop ──
app.post("/api/stop", checkAuth, (req, res) => {
  if (!ffmpegProcess) return res.status(404).json({ error: "No active stream" });
  log("Stopped by user");
  killFFmpeg();
  streamStatus = "idle";
  res.json({ ok: true, message: "Stream stopped" });
});

// ── Status ──
app.get("/api/status", checkAuth, (req, res) => {
  res.json({ status: streamStatus, config: currentConfig, logs: streamLogs.slice(-60) });
});

// ── Health ──
app.get("/api/health", (req, res) => res.json({ ok: true, status: streamStatus }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RadioCast backend listening on port ${PORT}`));

process.on("exit", killFFmpeg);
process.on("SIGINT", () => { killFFmpeg(); process.exit(0); });
process.on("SIGTERM", () => { killFFmpeg(); process.exit(0); });
