const crypto = require("crypto");
const { query, queryOne } = require("../db/database");

const SESSION_COOKIE = "itrm_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCRYPT_KEYLEN = 64;

// Plain HTTP by default (see README "Deploying it"); only mark the cookie Secure when told to.
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split("$");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookieHeader(token, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookieHeader() {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (COOKIE_SECURE) parts.push("Secure");
  return parts.join("; ");
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}

async function findUserByUsername(username) {
  return queryOne("SELECT * FROM dbo.users WHERE username = @username AND is_active = 1", { username });
}

// Creates a session row and returns { token, setCookieHeader }.
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query("INSERT INTO dbo.sessions (token, user_id, expires_at) VALUES (@token, @userId, @expiresAt)", {
    token,
    userId,
    expiresAt,
  });
  return { token, setCookieHeader: sessionCookieHeader(token, SESSION_TTL_MS / 1000) };
}

async function destroySession(token) {
  if (!token) return;
  await query("DELETE FROM dbo.sessions WHERE token = @token", { token });
}

// Resolves the logged-in user (or null) for an incoming request from its session cookie.
async function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const row = await queryOne(
    `SELECT u.id, u.username, u.name, u.role
       FROM dbo.sessions s
       JOIN dbo.users u ON u.id = s.user_id AND u.is_active = 1
      WHERE s.token = @token AND s.expires_at > SYSUTCDATETIME()`,
    { token }
  );
  return publicUser(row);
}

module.exports = {
  SESSION_COOKIE,
  hashPassword,
  verifyPassword,
  parseCookies,
  sessionCookieHeader,
  clearSessionCookieHeader,
  publicUser,
  findUserByUsername,
  createSession,
  destroySession,
  getSessionUser,
};
