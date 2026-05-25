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

function buildArgs(id) {
  const { inputUrl, rtmpUrl, streamKey, videoBitrate, audioBitrate, audioOnly, lowCpu, showLogo, logoText, hlsQuality = "best" } = instances[id].config;
  const rtmpTarget = rtmpUrl.replace(/\/$/, "") + "/" + streamKey;

  // Detect HLS input
  const isHLS = /\.m3u8(\?|$)/i.test(inputUrl) || /hls/i.test(inputUrl);

  // Plain HTTP stream flags (MP3, AAC, OGG)
  const httpFlags = [
    "-re",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "10",
    "-stream_loop", "-1",
    "-timeout", "10000000",
  ];

  // HLS flags — no -re, HLS self-throttles via segment timing
  const hlsFlags = [
    "-allowed_extensions", "ALL",
    "-protocol_whitelist", "file,http,https,tcp,tls,crypto",
    "-live_start_index", "-3",
    "-max_reload", "1000",
    "-m3u8_hold_counters", "1000",
    "-reconnect", "1",
    "-reconnect_delay_max", "10",
    "-thread_queue_size", "512",
    "-err_detect", "ignore_err",
  ];

  const inputArgs = isHLS
    ? [...hlsFlags, "-i", inputUrl]
    : [...httpFlags, "-i", inputUrl];

  // ── AUDIO ONLY ──
  if (audioOnly) {
    return [
      ...inputArgs,
      "-map", "0:a:0",
      "-vn",
      "-c:a", "aac", "-b:a", audioBitrate, "-ar", "44100", "-ac", "2",
      "-f", "flv", rtmpTarget
    ];
  }

  // ── HLS SOURCE: passthrough video, only re-encode audio ──
  // Zero encoding cost — uses ~1% CPU regardless of resolution
  // 0:V:0 (capital V) = FFmpeg picks the highest resolution stream automatically
  // 0:v:0 (lowercase v) = first declared stream (usually lowest quality)
  if (isHLS) {
    const useBest = hlsQuality !== "low";
    const videoMap = useBest
      ? ["-map", "0:V:0", "-map", "0:a:0"]   // highest resolution variant
      : ["-map", "0:v:0", "-map", "0:a:0"];  // lowest/first variant
    const args = [
      ...inputArgs,
      ...videoMap,
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", audioBitrate,
      "-ar", "44100", "-ac", "2",
      "-f", "flv", rtmpTarget
    ];
    return args;
  }

  // ── PLAIN AUDIO SOURCE (MP3/AAC): generate black canvas + encode ──
  // CBR mode forces real bitrate even for static black frame
  function videoEncodeArgs(bitrate, bufsize) {
    return [
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p",
      "-b:v", bitrate,
      "-minrate", bitrate,
      "-maxrate", bitrate,
      "-bufsize", bufsize,
      "-x264-params", "nal-hrd=cbr:force-cfr=1",
      "-profile:v", "baseline",
      "-level", "4.0",
    ];
  }

  if (lowCpu) {
    const args = [
      ...inputArgs,
      "-f", "lavfi", "-i", "color=c=black:size=1280x720:rate=30",
      "-map", "1:v:0",
      "-map", "0:a:0",
      ...videoEncodeArgs("2500k", "5000k"),
      "-g", "60", "-r", "30",
    ];
    if (showLogo && logoText) {
      const safe = logoText.replace(/'/g, "\\'").replace(/:/g, "\\:");
      args.push("-vf", `drawtext=text='${safe}':fontcolor=white:fontsize=28:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=8`);
    }
    args.push("-c:a", "aac", "-b:a", audioBitrate, "-ar", "44100", "-ac", "2", "-f", "flv", rtmpTarget);
    return args;
  }

  // Normal — 720p configurable bitrate
  const args = [
    ...inputArgs,
    "-f", "lavfi", "-i", "color=c=black:size=1280x720:rate=30",
    "-map", "1:v:0",
    "-map", "0:a:0",
    ...videoEncodeArgs(videoBitrate, String(parseInt(videoBitrate) * 2) + "k"),
    "-g", "60", "-r", "30",
  ];
  if (showLogo && logoText) {
    const safe = logoText.replace(/'/g, "\\'").replace(/:/g, "\\:");
    args.push("-vf", `drawtext=text='${safe}':fontcolor=white:fontsize=36:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.5:boxborderw=10`);
  }
  args.push("-c:a", "aac", "-b:a", audioBitrate, "-ar", "44100", "-ac", "2", "-f", "flv", rtmpTarget);
  return args;
}

// ── Auto-restart spawn loop ──
const MAX_RESTARTS = 20;
const RESTART_DELAY_MS = 3000;

function spawnFFmpeg(id) {
  if (!instances[id] || instances[id].stopped) return;

  const args = buildArgs(id);
  const proc = spawn("ffmpeg", args);
  instances[id].process = proc;
  instances[id].status  = "connecting";

  proc.stderr.on("data", (data) => {
    if (!instances[id]) return;
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
    if (!instances[id] || instances[id].stopped) return;
    logTo(id, `FFmpeg exited (code ${code})`, code === 0 ? "info" : "error");
    instances[id].process = null;

    if (instances[id].restarts >= MAX_RESTARTS) {
      logTo(id, `Max restarts (${MAX_RESTARTS}) reached. Stopping.`, "error");
      instances[id].status = "error";
      return;
    }
    instances[id].restarts++;
    logTo(id, `Auto-restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${instances[id].restarts}/${MAX_RESTARTS})…`, "info");
    setTimeout(() => spawnFFmpeg(id), RESTART_DELAY_MS);
  });

  proc.on("error", (err) => {
    if (!instances[id]) return;
    logTo(id, `Spawn error: ${err.message}`, "error");
    instances[id].process = null;
    instances[id].status  = "error";
  });

  // After 5s without error, mark live and reset restart counter
  setTimeout(() => {
    if (instances[id]?.status === "connecting") instances[id].status = "live";
    if (instances[id]?.status === "live")       instances[id].restarts = 0;
  }, 5000);
}

// ── Start ──
app.post("/api/start", checkAuth, (req, res) => {
  const {
    id: requestedId,
    inputUrl, rtmpUrl, streamKey,
    videoBitrate = "100k", audioBitrate = "128k",
    showLogo = false, logoText = "",
    audioOnly = false,
    lowCpu = true,
    hlsQuality = "best"   // "best" | "low" — which HLS variant to use
  } = req.body;

  if (!inputUrl || !rtmpUrl || !streamKey)
    return res.status(400).json({ error: "inputUrl, rtmpUrl and streamKey are required" });

  const id = requestedId || makeId();
  if (instances[id] && (instances[id].status === "live" || instances[id].status === "connecting"))
    return res.status(409).json({ error: `Instance "${id}" is already running. Stop it first or use a different name.` });

  instances[id] = {
    process: null, status: "connecting",
    config: { inputUrl, rtmpUrl, streamKey, videoBitrate, audioBitrate, showLogo, logoText, audioOnly, lowCpu, hlsQuality },
    logs: [], startedAt: new Date().toISOString(),
    stopped: false, restarts: 0
  };

  logTo(id, `Starting [${audioOnly ? "audio-only" : lowCpu ? "low-cpu" : "normal"}] [hls:${hlsQuality}]: ${inputUrl} → ${rtmpUrl}/${streamKey}`);
  spawnFFmpeg(id);

  res.json({ ok: true, id, message: `Stream "${id}" starting…` });
});

// ── Stop one ──
app.post("/api/stop/:id", checkAuth, (req, res) => {
  const { id } = req.params;
  if (!instances[id]) return res.status(404).json({ error: `No instance "${id}" found` });
  logTo(id, "Stopped by user");
  instances[id].stopped = true;
  killInstance(id);
  instances[id].status = "idle";
  res.json({ ok: true, message: `Stream "${id}" stopped` });
});

// ── Stop ALL ──
app.post("/api/stopall", checkAuth, (req, res) => {
  const ids = Object.keys(instances);
  ids.forEach(id => {
    instances[id].stopped = true;
    killInstance(id);
    instances[id].status = "idle";
  });
  res.json({ ok: true, message: `Stopped ${ids.length} stream(s)` });
});

// ── Status ──
app.get("/api/status/:id", checkAuth, (req, res) => {
  const { id } = req.params;
  if (!instances[id]) return res.status(404).json({ error: `No instance "${id}" found` });
  const inst = instances[id];
  res.json({ id, status: inst.status, config: inst.config, logs: inst.logs.slice(-60), startedAt: inst.startedAt });
});

// ── List all ──
app.get("/api/instances", checkAuth, (req, res) => {
  const list = Object.entries(instances).map(([id, inst]) => ({
    id, status: inst.status, startedAt: inst.startedAt,
    inputUrl: inst.config?.inputUrl, rtmpUrl: inst.config?.rtmpUrl,
  }));
  res.json({ instances: list });
});

// ── Health ──
app.get("/api/health", (req, res) => {
  const running = Object.values(instances).filter(i => i.status === "live" || i.status === "connecting").length;
  res.json({ ok: true, activeStreams: running });
});

// ── Keepalive self-ping — prevents Render/Railway free tier sleep ──
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || null;
setInterval(() => {
  const url = KEEPALIVE_URL || `http://localhost:${PORT}/api/health`;
  const mod = url.startsWith("https") ? require("https") : require("http");
  mod.get(url, () => {}).on("error", () => {});
  console.log(`[keepalive] ping → ${url}`);
}, 4 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RadioCast backend on port ${PORT}`));

const cleanup = () => { Object.keys(instances).forEach(killInstance); process.exit(0); };
process.on("exit",   () => Object.keys(instances).forEach(killInstance));
process.on("SIGINT",  cleanup);
process.on("SIGTERM", cleanup);
