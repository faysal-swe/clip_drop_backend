require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mediaRoutes = require("./routes/media.routes");

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// API Routes
app.use("/api", mediaRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({
    ok: false,
    code: "internal_error",
    message: err.message || "Internal server error.",
  });
});

app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`🚀 ClipDrop Backend running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Fetch info:   POST http://localhost:${PORT}/api/fetch-info`);
  console.log(`   Proxy stream: GET http://localhost:${PORT}/api/proxy-stream`);
  console.log(`=================================`);
});
