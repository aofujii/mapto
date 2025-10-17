const express = require("express");
const path = require("path");
const { randomUUID } = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const POST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_RADIUS_METERS = 5000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

initializeDatabase()
  .then(() => purgeExpiredPosts())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });

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

app.get("/api/posts", async (req, res) => {
  try {
    await purgeExpiredPosts();

    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radiusMeters =
      parseFloat(req.query.radius) || DEFAULT_RADIUS_METERS;

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || radiusMeters <= 0) {
      return res
        .status(400)
        .json({ error: "lat, lng, and radius must be valid numbers" });
    }

    const posts = await fetchRecentPosts();
    const nearby = posts
      .filter((post) => {
        const distance = distanceInMeters(lat, lng, post.lat, post.lng);
        return distance <= radiusMeters;
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .map((post) => ({
        ...post,
        ageMs: Date.now() - post.timestamp,
      }));

    res.json(nearby);
  } catch (error) {
    console.error("Failed to load posts:", error);
    res.status(500).json({ error: "Failed to load posts" });
  }
});

app.post("/api/posts", async (req, res) => {
  try {
    await purgeExpiredPosts();

    const { lat, lng, text, mood } = req.body || {};

    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res
        .status(400)
        .json({ error: "lat and lng are required numbers" });
    }

    const hasText = typeof text === "string" && text.trim().length > 0;
    const hasMood = typeof mood === "string" && mood.trim().length > 0;

    if (!hasText && !hasMood) {
      return res
        .status(400)
        .json({ error: "Either text or mood must be provided" });
    }

    const sanitizedText = sanitizeText(text);
    const sanitizedMood = sanitizeMood(mood);

    const timestamp = Date.now();

    const post = await createPost({
      id: randomUUID(),
      lat: latNum,
      lng: lngNum,
      text: sanitizedText,
      mood: sanitizedMood || null,
      timestamp,
      likes: 0,
    });

    res.status(201).json(post);
  } catch (error) {
    console.error("Failed to create post:", error);
    res.status(500).json({ error: "Failed to create post" });
  }
});

app.post("/api/posts/:id/like", async (req, res) => {
  try {
    await purgeExpiredPosts();

    const result = await incrementLikes(req.params.id);
    if (!result) {
      return res.status(404).json({ error: "Post not found" });
    }

    res.json(result);
  } catch (error) {
    console.error("Failed to like post:", error);
    res.status(500).json({ error: "Failed to like post" });
  }
});

// Purge old posts periodically to keep memory usage predictable.
setInterval(() => {
  purgeExpiredPosts().catch((error) =>
    console.warn("Failed to purge posts:", error)
  );
}, 5 * 60 * 1000); // every 5 minutes

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function initializeDatabase() {
  if (!pool.options.connectionString) {
    throw new Error(
      "DATABASE_URL environment variable must be set to connect to PostgreSQL",
    );
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id UUID PRIMARY KEY,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      text TEXT NOT NULL,
      mood TEXT,
      timestamp BIGINT NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0
    )
  `);
}

async function purgeExpiredPosts() {
  const cutoff = Date.now() - POST_TTL_MS;
  const result = await pool.query("DELETE FROM posts WHERE timestamp < $1", [
    cutoff,
  ]);
  return result.rowCount;
}

async function fetchRecentPosts() {
  const cutoff = Date.now() - POST_TTL_MS;
  const { rows } = await pool.query(
    `
      SELECT id, lat, lng, text, mood, timestamp, likes
      FROM posts
      WHERE timestamp >= $1
    `,
    [cutoff],
  );
  return rows.map(normalizeRow).filter((post) => post !== null);
}

async function createPost(post) {
  const { rows } = await pool.query(
    `
      INSERT INTO posts (id, lat, lng, text, mood, timestamp, likes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, lat, lng, text, mood, timestamp, likes
    `,
    [
      post.id,
      post.lat,
      post.lng,
      post.text,
      post.mood,
      post.timestamp,
      post.likes,
    ],
  );

  return normalizeRow(rows[0]);
}

async function incrementLikes(id) {
  const { rows } = await pool.query(
    `
      UPDATE posts SET likes = likes + 1
      WHERE id = $1
      RETURNING id, likes
    `,
    [id],
  );

  if (rows.length === 0) {
    return null;
  }

  return { id: rows[0].id, likes: Number(rows[0].likes) };
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

function sanitizeText(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const limited = Array.from(trimmed).slice(0, 500).join("");
  return limited || trimmed;
}

function sanitizeMood(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const limited = Array.from(trimmed).slice(0, 4).join("");
  return limited || trimmed;
}

function normalizeRow(entry) {
  if (!entry) {
    return null;
  }

  const lat = Number(entry.lat);
  const lng = Number(entry.lng);
  const timestamp = Number(entry.timestamp);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    !Number.isFinite(timestamp)
  ) {
    return null;
  }

  const text = sanitizeText(entry.text);
  const mood = sanitizeMood(entry.mood);
  const likes = Number(entry.likes);

  return {
    id: typeof entry.id === "string" ? entry.id : randomUUID(),
    lat,
    lng,
    text,
    mood: mood || null,
    timestamp,
    likes: Number.isFinite(likes) && likes >= 0 ? Math.floor(likes) : 0,
  };
}
