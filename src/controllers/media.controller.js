const { fetchMetadata, normalizeVideoInfo, createStreamProcess } = require("../services/ytdlp.service");

/**
 * Controller: Handles POST /api/fetch-info
 */
async function fetchInfo(req, res) {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string" || !url.trim()) {
      return res.status(400).json({
        ok: false,
        code: "invalid_url",
        message: "Please provide a valid video link.",
      });
    }

    const cleanUrl = url.trim();

    // Basic URL check
    try {
      new URL(cleanUrl);
    } catch {
      return res.status(400).json({
        ok: false,
        code: "invalid_url",
        message: "That doesn't look like a valid URL.",
      });
    }

    console.log(`[fetch-info] Analyzing URL: ${cleanUrl}`);
    const rawJson = await fetchMetadata(cleanUrl);
    const video = normalizeVideoInfo(rawJson, cleanUrl);

    return res.json({
      ok: true,
      video,
    });
  } catch (error) {
    console.error("[fetch-info] Error:", error.message);
    let code = "video_unavailable";
    let message = "Could not process or extract media from this URL.";

    if (error.message.includes("Private video") || error.message.includes("Login required")) {
      code = "private_video";
      message = "This video is private or requires login.";
    } else if (error.message.includes("Copyright") || error.message.includes("blocked")) {
      code = "copyright_restricted";
      message = "This video is restricted and cannot be downloaded.";
    } else if (error.message.includes("Sign in to confirm") || error.message.includes("not a bot")) {
      code = "bot_verification_required";
      message = "YouTube blocked the server request with a bot check. Cookies or authentication required.";
    }

    return res.status(500).json({
      ok: false,
      code,
      message,
    });
  }
}

/**
 * Helper to sanitize filenames for Content-Disposition header
 */
function sanitizeFilename(filename, fallback = "media") {
  if (!filename) return fallback;
  return filename.replace(/[^a-zA-Z0-9_\-\.\s]/g, "").trim() || fallback;
}

/**
 * Controller: Handles GET /api/proxy-stream
 *
 * Zero-Storage Proxy: Streams media directly from platform CDNs through
 * FFmpeg to the client browser. Nothing is written to server disk.
 *
 * Flow: Platform CDN → FFmpeg (in-memory remux) → HTTP Response → Browser Download
 */
async function proxyStream(req, res) {
  let proc = null;

  try {
    const { videoUrl, streamUrl, formatId, filename, kind, resolution, container } = req.query;

    const safeKind = kind === "audio" ? "audio" : "video";
    const safeContainer = safeKind === "audio" ? (container || "mp3").toLowerCase() : "mp4";
    let safeName = sanitizeFilename(filename, "media");
    if (!safeName.toLowerCase().endsWith(`.${safeContainer}`)) {
      safeName = `${safeName}.${safeContainer}`;
    }

    let mimeType = "video/mp4";
    if (safeKind === "audio") {
      if (safeContainer === "mp3") mimeType = "audio/mpeg";
      else if (safeContainer === "wav") mimeType = "audio/wav";
      else mimeType = "audio/mp4";
    }

    const targetVideoUrl = videoUrl || streamUrl;
    if (!targetVideoUrl) {
      return res.status(400).send("Missing video URL for streaming.");
    }

    console.log(`[proxy-stream] ${safeKind} request (${safeContainer}): ${targetVideoUrl} (format: ${formatId || "best"}, res: ${resolution || "auto"})`);

    // Get CDN URLs and spawn FFmpeg pipe (zero storage)
    proc = await createStreamProcess(targetVideoUrl, formatId, safeKind, resolution || 0, safeContainer);

    // Set headers for browser download
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
    );
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    // Pipe FFmpeg stdout directly to browser
    proc.stdout.pipe(res);

    // Log FFmpeg warnings/errors
    proc.stderr.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (msg && !msg.includes("configuration:") && !msg.includes("built with")) {
        console.error("[ffmpeg log]:", msg);
      }
    });

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        console.error(`[ffmpeg] Process exited with code ${code}`);
        if (!res.headersSent) {
          res.status(500).send("Stream processing failed.");
        }
      } else {
        console.log(`[proxy-stream] Direct stream completed: ${safeName}`);
      }
    });

    proc.on("error", (err) => {
      console.error("[ffmpeg] Process error:", err.message);
      if (!res.headersSent) {
        res.status(500).send("Failed to start stream process.");
      }
    });

    // Kill FFmpeg & yt-dlp if client disconnects mid-download
    req.on("close", () => {
      if (proc && !proc.killed) {
        proc.kill("SIGTERM");
      }
      if (proc && proc.ytdlpProc && !proc.ytdlpProc.killed) {
        proc.ytdlpProc.kill("SIGTERM");
      }
      console.log("[proxy-stream] Client disconnected, killed active stream processes.");
    });

  } catch (error) {
    console.error("[proxy-stream] Error:", error.message);
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
    if (!res.headersSent) {
      res.status(500).send("Failed to stream media content. " + error.message);
    }
  }
}

module.exports = {
  fetchInfo,
  proxyStream,
};
