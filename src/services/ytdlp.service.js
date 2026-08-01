const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const axios = require("axios");
const ffmpegStatic = require("ffmpeg-static");

const BIN_DIR = path.join(__dirname, "../../bin");
const IS_WINDOWS = process.platform === "win32";
const BIN_NAME = IS_WINDOWS ? "yt-dlp.exe" : "yt-dlp";
const BIN_PATH = path.join(BIN_DIR, BIN_NAME);

// Use system ffmpeg if installed (e.g. Docker container), fallback to ffmpeg-static
const ffmpegPath = (() => {
  if (fs.existsSync("/usr/bin/ffmpeg")) return "/usr/bin/ffmpeg";
  if (fs.existsSync("/usr/local/bin/ffmpeg")) return "/usr/local/bin/ffmpeg";
  return ffmpegStatic;
})();

// Anti-bot & cloud datacenter bypass arguments for yt-dlp
const YTDLP_BYPASS_ARGS = [
  "--no-warnings",
  "--no-check-certificates",
  "--user-agent",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
  "--extractor-args",
  "youtube:player_client=ios,mweb;player_skip=webpage,configs",
];

function getSystemYtDlp() {
  if (fs.existsSync("/usr/local/bin/yt-dlp")) return "/usr/local/bin/yt-dlp";
  if (fs.existsSync("/usr/bin/yt-dlp")) return "/usr/bin/yt-dlp";
  return null;
}

// Ensure bin directory exists
if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

/**
 * Downloads yt-dlp executable if it does not exist locally.
 */
async function ensureBinary() {
  const sysBin = getSystemYtDlp();
  if (sysBin) {
    return sysBin;
  }

  if (fs.existsSync(BIN_PATH)) {
    return BIN_PATH;
  }

  console.log(`yt-dlp binary not found at ${BIN_PATH}. Downloading official binary...`);
  const downloadUrl = IS_WINDOWS
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  const response = await axios({
    method: "get",
    url: downloadUrl,
    responseType: "stream",
  });

  const writer = fs.createWriteStream(BIN_PATH);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  if (!IS_WINDOWS) {
    fs.chmodSync(BIN_PATH, "755");
  }

  console.log("yt-dlp binary downloaded successfully.");
  return BIN_PATH;
}

/**
 * Helper to format seconds into HH:MM:SS or MM:SS
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "0:00";
  const sec = Math.floor(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (num) => String(num).padStart(2, "0");
  if (h > 0) {
    return `${h}:${pad(m)}:${pad(s)}`;
  }
  return `${m}:${pad(s)}`;
}

/**
 * Helper to format bytes into readable string (e.g., 14.2 MB)
 */
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes === 0) return "Unknown size";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Helper to format view counts
 */
function formatViews(views) {
  if (!views || isNaN(views)) return undefined;
  if (views >= 1_000_000) {
    return `${(views / 1_000_000).toFixed(1)}M views`;
  }
  if (views >= 1_000) {
    return `${(views / 1_000).toFixed(1)}K views`;
  }
  return `${views} views`;
}

/**
 * Helper to format date string YYYYMMDD -> "MMM DD, YYYY"
 */
function formatDate(dateStr) {
  if (!dateStr || dateStr.length !== 8) return "Recently uploaded";
  const year = dateStr.substring(0, 4);
  const monthIdx = parseInt(dateStr.substring(4, 6), 10) - 1;
  const day = parseInt(dateStr.substring(6, 8), 10);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  if (monthIdx >= 0 && monthIdx < 12) {
    return `${months[monthIdx]} ${day}, ${year}`;
  }
  return dateStr;
}

/**
 * Extracts metadata using yt-dlp -j
 */
async function fetchMetadata(url) {
  const binPath = await ensureBinary();

  return new Promise((resolve, reject) => {
    const args = [
      "-j",
      "--no-playlist",
      ...YTDLP_BYPASS_ARGS,
      url,
    ];

    execFile(
      binPath,
      args,
      { maxBuffer: 1024 * 1024 * 50 }, // 50MB buffer
      (error, stdout, stderr) => {
        if (error) {
          console.error("yt-dlp exec error:", stderr || error.message);
          return reject(new Error(stderr || error.message || "Failed to extract metadata"));
        }

        try {
          const json = JSON.parse(stdout);
          resolve(json);
        } catch (parseErr) {
          reject(new Error("Failed to parse yt-dlp metadata JSON output"));
        }
      }
    );
  });
}

/**
 * Normalizes metadata into clean structure required by frontend
 */
function normalizeVideoInfo(rawJson, rawUrl) {
  const title = rawJson.title || rawJson.fulltitle || "Video";
  const channel =
    rawJson.uploader ||
    rawJson.channel ||
    rawJson.creator ||
    rawJson.extractor_key ||
    "Unknown Channel";

  const rawPlatform = rawJson.extractor_key || rawJson.extractor || "Video";
  let platform = "YouTube";
  if (/tiktok/i.test(rawPlatform)) platform = "TikTok";
  else if (/instagram/i.test(rawPlatform)) platform = "Instagram";
  else if (/facebook/i.test(rawPlatform)) platform = "Facebook";
  else if (/twitter|x/i.test(rawPlatform)) platform = "X";
  else if (/vimeo/i.test(rawPlatform)) platform = "Vimeo";
  else if (/reddit/i.test(rawPlatform)) platform = "Reddit";
  else if (/twitch/i.test(rawPlatform)) platform = "Twitch";
  else if (/dailymotion/i.test(rawPlatform)) platform = "Dailymotion";
  else if (/youtube/i.test(rawPlatform)) platform = "YouTube";

  const duration = formatDuration(rawJson.duration);
  const uploadDate = formatDate(rawJson.upload_date);
  const views = formatViews(rawJson.view_count);

  // Best thumbnail
  let thumbnailUrl = rawJson.thumbnail;
  if (Array.isArray(rawJson.thumbnails) && rawJson.thumbnails.length > 0) {
    thumbnailUrl = rawJson.thumbnails[rawJson.thumbnails.length - 1].url || thumbnailUrl;
  }

  // Parse Formats
  const formatsList = [];
  const rawFormats = Array.isArray(rawJson.formats) ? rawJson.formats : [];

  // Group all video formats by height so every resolution (including video-only 1080p, 1440p, 4K, 720p, etc.) is captured
  const videoByHeight = new Map();

  for (const f of rawFormats) {
    if (!f) continue;
    const hasVideo = f.vcodec && f.vcodec !== "none";
    if (!hasVideo) continue;

    const height = f.height || (f.format_note ? parseInt(f.format_note, 10) : 0);
    if (!height || isNaN(height)) continue;

    const hasAudio = Boolean(f.acodec && f.acodec !== "none");
    const ext = (f.ext || "").toLowerCase();
    const vcodec = (f.vcodec || "").toLowerCase();
    const size = f.filesize || f.filesize_approx || 0;
    const tbr = f.tbr || 0;
    const fps = f.fps || 0;

    // Prefer mp4 container, avc1/h264 codec, higher fps/bitrate
    let score = 0;
    if (ext === "mp4") score += 100;
    if (vcodec.startsWith("avc1") || vcodec.startsWith("h264")) score += 50;
    if (fps >= 50) score += 20;
    score += Math.min(tbr, 50);

    const existing = videoByHeight.get(height);
    if (!existing || score > existing.score || (score === existing.score && size > existing.size)) {
      videoByHeight.set(height, {
        format: f,
        score,
        size,
        height,
        hasAudio,
      });
    }
  }

  // Convert collected video formats into formatted list items
  for (const [height, data] of videoByHeight.entries()) {
    const f = data.format;
    formatsList.push({
      id: String(f.format_id),
      kind: "video",
      label: `${height}p`,
      container: "mp4",
      fileSize: formatBytes(data.size),
      url: f.url,
      formatId: String(f.format_id),
      videoUrl: rawUrl,
      resolution: height,
      needsMux: !data.hasAudio,
    });
  }

  // Collect structured, user-selectable audio formats
  const durationSec = rawJson.duration && !isNaN(rawJson.duration) ? rawJson.duration : 0;

  const audioFormats = [
    {
      id: "audio_mp3_320",
      kind: "audio",
      label: "MP3 (320 kbps)",
      container: "mp3",
      fileSize: durationSec > 0 ? formatBytes(Math.round((durationSec * 320 * 1000) / 8)) : "Audio MP3",
      formatId: "bestaudio",
      videoUrl: rawUrl,
    },
    {
      id: "audio_mp3_128",
      kind: "audio",
      label: "MP3 (128 kbps)",
      container: "mp3",
      fileSize: durationSec > 0 ? formatBytes(Math.round((durationSec * 128 * 1000) / 8)) : "Audio MP3",
      formatId: "bestaudio",
      videoUrl: rawUrl,
    },
    {
      id: "audio_m4a",
      kind: "audio",
      label: "M4A (AAC)",
      container: "m4a",
      fileSize: durationSec > 0 ? formatBytes(Math.round((durationSec * 192 * 1000) / 8)) : "Audio M4A",
      formatId: "bestaudio",
      videoUrl: rawUrl,
    },
    {
      id: "audio_wav",
      kind: "audio",
      label: "WAV (Lossless)",
      container: "wav",
      fileSize: durationSec > 0 ? formatBytes(Math.round(durationSec * 44100 * 2 * 2)) : "Audio WAV",
      formatId: "bestaudio",
      videoUrl: rawUrl,
    },
  ];

  // Fallback if no video formats array found
  if (formatsList.length === 0 && rawJson.url) {
    formatsList.push({
      id: "best",
      kind: "video",
      label: "HD / Standard",
      container: "mp4",
      fileSize: formatBytes(rawJson.filesize || 0),
      url: rawJson.url,
      formatId: "best",
      videoUrl: rawUrl,
    });
  }

  // Sort video formats descending by resolution
  const videoFormats = formatsList
    .filter((f) => f.kind === "video")
    .sort((a, b) => parseInt(b.label, 10) - parseInt(a.label, 10));

  return {
    title,
    channel,
    platform,
    duration,
    uploadDate,
    views,
    thumbnailUrl,
    thumbnailLabel: videoFormats[0]?.label || "HD",
    formats: [...videoFormats, ...audioFormats],
  };
}

/**
 * Gets fresh CDN download URLs using yt-dlp -g.
 * Returns an array of URLs (1 for single stream, 2 for video+audio merge).
 */
function getCdnUrls(videoUrl, formatSpec, binPath) {
  return new Promise((resolve, reject) => {
    execFile(
      binPath,
      [
        "-g",
        "-f", formatSpec,
        "--no-playlist",
        ...YTDLP_BYPASS_ARGS,
        videoUrl,
      ],
      { maxBuffer: 1024 * 1024 * 10 },
      (error, stdout, stderr) => {
        if (error) {
          console.error("[getCdnUrls] Error:", stderr || error.message);
          return reject(new Error(stderr || error.message || "Failed to get CDN URLs"));
        }
        const urls = stdout.trim().split(/\r?\n/).filter(Boolean);
        if (urls.length === 0) {
          return reject(new Error("No CDN URLs returned by yt-dlp"));
        }
        resolve(urls);
      }
    );
  });
}

/**
 * Zero-Storage Direct Proxy Stream
 *
 * Spawns yt-dlp to stream content directly from platform CDNs into standard output,
 * piping byte-by-byte into FFmpeg for fragmented MP4 packaging (-movflags frag_keyframe+empty_moov).
 *
 * Absolute Zero Disk Storage: No file is created on server disk drives.
 * Flow: Platform CDN → yt-dlp (RAM stream) → FFmpeg (RAM pipe) → HTTP Response → Client Device
 */
async function createStreamProcess(videoUrl, formatId, kind = "video", resolution = 0, container = "mp4") {
  const binPath = await ensureBinary();
  const numericRes = parseInt(resolution, 10) || 0;
  const safeContainer = (container || (kind === "audio" ? "mp3" : "mp4")).toLowerCase();

  let formatSpec;
  let ffmpegArgs = [];

  if (kind === "audio") {
    formatSpec = "bestaudio/best";

    if (safeContainer === "mp3") {
      const bitrate = formatId === "audio_mp3_128" ? "128k" : "320k";
      ffmpegArgs = [
        "-loglevel", "warning",
        "-i", "pipe:0",
        "-vn",
        "-c:a", "libmp3lame",
        "-b:a", bitrate,
        "-f", "mp3",
        "pipe:1"
      ];
    } else if (safeContainer === "wav") {
      ffmpegArgs = [
        "-loglevel", "warning",
        "-i", "pipe:0",
        "-vn",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        "pipe:1"
      ];
    } else {
      // m4a / aac
      ffmpegArgs = [
        "-loglevel", "warning",
        "-i", "pipe:0",
        "-vn",
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "frag_keyframe+empty_moov",
        "-f", "mp4",
        "pipe:1"
      ];
    }
  } else {
    // kind === "video"
    if (formatId && formatId !== "best") {
      formatSpec = `${formatId}+bestaudio/${formatId}/best`;
    } else if (numericRes > 0) {
      formatSpec = `bestvideo[height<=${numericRes}]+bestaudio/best[height<=${numericRes}]/best`;
    } else {
      formatSpec = "bestvideo+bestaudio/best";
    }

    // Always transcode audio to standard AAC 192k to guarantee universal audio playback across all devices/players
    ffmpegArgs = [
      "-loglevel", "warning",
      "-i", "pipe:0",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "frag_keyframe+empty_moov",
      "-f", "mp4",
      "pipe:1"
    ];
  }

  console.log(`[stream] Spawning zero-storage yt-dlp direct pipe (kind: "${kind}", container: "${safeContainer}", format: "${formatSpec}")...`);

  // Step 1: Spawn yt-dlp directly with stdout pipe (-o -)
  const ytdlpArgs = [
    "-f", formatSpec,
    "-o", "-",
    "--no-playlist",
    ...YTDLP_BYPASS_ARGS,
    "--ffmpeg-location", ffmpegPath,
    videoUrl,
  ];

  const ytdlpProc = spawn(binPath, ytdlpArgs);

  // Step 2: Spawn FFmpeg to transcode/package in-memory stream into HTTP output
  const ffmpegProc = spawn(ffmpegPath, ffmpegArgs);

  // Pipe yt-dlp stdout into FFmpeg stdin
  ytdlpProc.stdout.pipe(ffmpegProc.stdin);

  // Log warnings if any
  ytdlpProc.stderr.on("data", (chunk) => {
    const msg = chunk.toString().trim();
    if (msg && !msg.includes("[download]") && !msg.includes("Resuming")) {
      console.error("[yt-dlp stream log]:", msg);
    }
  });

  ytdlpProc.on("error", (err) => {
    console.error("[yt-dlp stream process error]:", err.message);
    if (!ffmpegProc.killed) ffmpegProc.kill("SIGTERM");
  });

  ffmpegProc.stdin.on("error", (err) => {
    if (err.code !== "EPIPE") {
      console.error("[ffmpeg stdin error]:", err.message);
    }
  });

  // Attach ytdlpProc reference to ffmpegProc so controller can kill both on abort
  ffmpegProc.ytdlpProc = ytdlpProc;

  return ffmpegProc;
}

module.exports = {
  ensureBinary,
  fetchMetadata,
  normalizeVideoInfo,
  createStreamProcess,
};
