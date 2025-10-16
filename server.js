const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const POST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_RADIUS_METERS = 5000;

/** @type {Array<Post>} */
const posts = [];

/**
 * @typedef {Object} Post
 * @property {string} id
 * @property {number} lat
 * @property {number} lng
 * @property {string} text
 * @property {string | null} mood
 * @property {number} timestamp
 * @property {number} likes
 */

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/posts", (req, res) => {
  purgeExpiredPosts();

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radiusMeters = parseFloat(req.query.radius) || DEFAULT_RADIUS_METERS;

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || radiusMeters <= 0) {
    return res
      .status(400)
      .json({ error: "lat, lng, and radius must be valid numbers" });
  }

  const nearby = posts.filter((post) => {
    const distance = distanceInMeters(lat, lng, post.lat, post.lng);
    return distance <= radiusMeters;
  });

  const sorted = nearby
    .slice()
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((post) => ({
      ...post,
      ageMs: Date.now() - post.timestamp,
    }));

  res.json(sorted);
});

app.post("/api/posts", (req, res) => {
  purgeExpiredPosts();

  const { lat, lng, text, mood } = req.body || {};

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);

  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return res.status(400).json({ error: "lat and lng are required numbers" });
  }

  const rawText = typeof text === "string" ? text : "";
  const sanitizedText = rawText.trim().slice(0, 500);
  const rawMood = typeof mood === "string" ? mood : "";
  const sanitizedMood = rawMood.trim().slice(0, 8);

  if (!sanitizedText && !sanitizedMood) {
    return res
      .status(400)
      .json({ error: "Either text or mood must be provided" });
  }

  const timestamp = Date.now();

  const post = {
    id: randomUUID(),
    lat: latNum,
    lng: lngNum,
    text: sanitizedText,
    mood: sanitizedMood || null,
    timestamp,
    likes: 0,
  };

  posts.push(post);
  res.status(201).json(post);
});

app.post("/api/posts/:id/like", (req, res) => {
  purgeExpiredPosts();

  const post = posts.find((entry) => entry.id === req.params.id);
  if (!post) {
    return res.status(404).json({ error: "Post not found" });
  }

  post.likes += 1;
  res.json({ id: post.id, likes: post.likes });
});

// Purge old posts periodically to keep memory usage predictable.
setInterval(purgeExpiredPosts, 5 * 60 * 1000); // every 5 minutes

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

function purgeExpiredPosts() {
  const cutoff = Date.now() - POST_TTL_MS;
  for (let i = posts.length - 1; i >= 0; i -= 1) {
    if (posts[i].timestamp < cutoff) {
      posts.splice(i, 1);
    }
  }
}

function distanceInMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // meters
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(value) {
  return (value * Math.PI) / 180;
}
