const express = require("express");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Optional API key auth
const API_KEY = process.env.API_KEY || null;
function checkAuth(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["authorization"] || req.query.key;
  if (key !== API_KEY && key !== `Bearer ${API_KEY}`) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ── Multi-instance store ──
// instances[id] = { process, status, config, logs, startedAt }
const instances = {};

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function logTo(id, msg, type = "info") {
  if (!instances[id]) return;
  const entry = { time: new Date().toISOString(), msg: String(msg).slice(0, 500), type };
  instances[id].logs.push(entry);
  if (instances[id].logs.length > 300) instances[id].logs = instances[id].logs.slice(-300);
  console.log(`[${id}][${type.toUpperCase()}] ${msg}`);
}

function killInstance(id) {
  const inst = instances[id];
  if (!inst) return;
  if (inst.process) {
    try { inst.process.kill("SIGKILL"); } catch (_) {}
    inst.process = null;
  }
}

// ── Start a new instance ──
app.post("/api/start", checkAuth, (req, res) => {
  const {
    id: requestedId,
    inputUrl, rtmpUrl, streamKey,
    videoBitrate = "100k", audioBitrate = "128k",
    showLogo = false, logoText = "",
    audioOnly = false,   // skip video entirely
    lowCpu = true        // use minimal video settings by default
  } = req.body;

  if (!inputUrl || !rtmpUrl || !streamKey)
    return res.status(400).json({ error: "inputUrl, rtmpUrl and streamKey are required" });

  const id = requestedId || makeId();
  if (instances[id] && (instances[id].status === "live" || instances[id].status === "connecting"))
    return res.status(409).json({ error: `Instance "${id}" is already running. Stop it first or use a different name.` });

  const rtmpTarget = rtmpUrl.replace(/\/$/, "") + "/" + streamKey;

  instances[id] = {
    process: null,
    status: "connecting",
    config: { inputUrl, rtmpUrl, streamKey, videoBitrate, audioBitrate, showLogo, logoText, audioOnly, lowCpu },
    logs: [],
    startedAt: new Date().toISOString()
  };

  logTo(id, `Starting [${audioOnly ? "audio-only" : lowCpu ? "low-cpu" : "normal"}]: ${inputUrl} → ${rtmpTarget}`);

  let args;

  if (audioOnly) {
    // ── Audio-only mode: no video track at all, minimal CPU ──
    args = [
      "-re",
      "-i", inputUrl,
      "-vn",                          // no video
      "-c:a", "aac",
      "-b:a", audioBitrate,
      "-ar", "44100", "-ac", "2",
      "-f", "flv", rtmpTarget
    ];
  } else if (lowCpu) {
    // ── Low-CPU mode: tiny 320x180 black canvas, very low bitrate ──
    // Uses ~5–10% CPU vs ~50% for full 1280x720
    args = [
      "-re",
      "-i", inputUrl,
      "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=10",  // 320×180 @ 10fps
      "-map", "1:v", "-map", "0:a",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-b:v", "80k", "-maxrate", "80k", "-bufsize", "160k",       // tiny bitrate
      "-g", "20", "-r", "10",                                      // 10fps keyframe every 2s
    ];
    if (showLogo && logoText) {
      const safe = logoText.replace(/'/g, "\\'").replace(/:/g, "\\:");
      args.push("-vf", `drawtext=text='${safe}':fontcolor=white:fontsize=14:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=4`);
    }
    args.push("-c:a", "aac", "-b:a", audioBitrate, "-ar", "44100", "-ac", "2", "-f", "flv", rtmpTarget);
  } else {
    // ── Normal mode: full 1280x720 ──
    args = [
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
    args.push("-c:a", "aac", "-b:a", audioBitrate, "-ar", "44100", "-ac", "2", "-f", "flv", rtmpTarget);
  }

  const proc = spawn("ffmpeg", args);
  instances[id].process = proc;

  proc.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (!text) return;
    if (/frame=|fps=|bitrate=|speed=/.test(text)) logTo(id, text, "progress");
    else {
      logTo(id, text, "ffmpeg");
      if (/Connection refused|No such file|Invalid data|error/i.test(text)) instances[id].status = "error";
      else if (/Stream mapping|Output #0/i.test(text)) instances[id].status = "live";
    }
  });

  proc.on("close", (code) => {
    logTo(id, `FFmpeg exited (code ${code})`, code === 0 ? "info" : "error");
    if (instances[id]) {
      instances[id].status = code === 0 ? "idle" : "error";
      instances[id].process = null;
    }
  });

  proc.on("error", (err) => {
    logTo(id, `Failed to spawn FFmpeg: ${err.message}`, "error");
    if (instances[id]) { instances[id].status = "error"; instances[id].process = null; }
  });

  setTimeout(() => {
    if (instances[id] && instances[id].status === "connecting") instances[id].status = "live";
  }, 4000);

  res.json({ ok: true, id, message: `Stream "${id}" starting…` });
});

// ── Stop one instance ──
app.post("/api/stop/:id", checkAuth, (req, res) => {
  const { id } = req.params;
  if (!instances[id]) return res.status(404).json({ error: `No instance "${id}" found` });
  logTo(id, "Stopped by user");
  killInstance(id);
  instances[id].status = "idle";
  res.json({ ok: true, message: `Stream "${id}" stopped` });
});

// ── Stop ALL instances ──
app.post("/api/stopall", checkAuth, (req, res) => {
  const ids = Object.keys(instances);
  ids.forEach(id => { killInstance(id); instances[id].status = "idle"; });
  res.json({ ok: true, message: `Stopped ${ids.length} stream(s)` });
});

// ── Status of one instance ──
app.get("/api/status/:id", checkAuth, (req, res) => {
  const { id } = req.params;
  if (!instances[id]) return res.status(404).json({ error: `No instance "${id}" found` });
  const inst = instances[id];
  res.json({ id, status: inst.status, config: inst.config, logs: inst.logs.slice(-60), startedAt: inst.startedAt });
});

// ── List all instances ──
app.get("/api/instances", checkAuth, (req, res) => {
  const list = Object.entries(instances).map(([id, inst]) => ({
    id,
    status: inst.status,
    startedAt: inst.startedAt,
    inputUrl: inst.config?.inputUrl,
    rtmpUrl: inst.config?.rtmpUrl,
  }));
  res.json({ instances: list });
});

// ── Health ──
app.get("/api/health", (req, res) => {
  const running = Object.values(instances).filter(i => i.status === "live" || i.status === "connecting").length;
  res.json({ ok: true, activeStreams: running });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RadioCast multi-instance backend on port ${PORT}`));

process.on("exit", () => Object.keys(instances).forEach(killInstance));
process.on("SIGINT", () => { Object.keys(instances).forEach(killInstance); process.exit(0); });
process.on("SIGTERM", () => { Object.keys(instances).forEach(killInstance); process.exit(0); });
