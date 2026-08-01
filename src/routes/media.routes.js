const express = require("express");
const { fetchInfo, proxyStream } = require("../controllers/media.controller");

const router = express.Router();

// 1. POST /api/fetch-info (and alias /api/analyze)
router.post("/fetch-info", fetchInfo);
router.post("/analyze", fetchInfo);

// 2. GET /api/proxy-stream
router.get("/proxy-stream", proxyStream);

module.exports = router;
