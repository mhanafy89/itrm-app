const { query, queryOne, isUniqueViolation } = require("../db/database");
const { sendJson, parseId } = require("../lib/http-helpers");
const auth = require("../lib/auth");

const ROLES = new Set(["read_only", "read_write"]);

function validateNewUser(body) {
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();
  const role = String(body.role || "");
  const errors = [];
  if (!username) errors.push("Username is required.");
  if (!name) errors.push("Name is required.");
  if (!password || password.length < 6) errors.push("Password must be at least 6 characters.");
  if (!ROLES.has(role)) errors.push("Role must be 'read_only' or 'read_write'.");
  return { username, password, name, role, errors };
}

async function login(req, res, _params, body) {
  const username = String((body && body.username) || "").trim();
  const password = String((body && body.password) || "");
  if (!username || !password) return sendJson(res, 400, { error: "Username and password are required." });

  const user = await auth.findUserByUsername(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    return sendJson(res, 401, { error: "Invalid username or password." });
  }

  const { setCookieHeader } = await auth.createSession(user.id);
  res.setHeader("Set-Cookie", setCookieHeader);
  sendJson(res, 200, { user: auth.publicUser(user) });
}

async function logout(req, res) {
  const token = auth.parseCookies(req)[auth.SESSION_COOKIE];
  await auth.destroySession(token);
  res.setHeader("Set-Cookie", auth.clearSessionCookieHeader());
  sendJson(res, 200, { ok: true });
}

function me(req, res) {
  sendJson(res, 200, { user: req.user });
}

// Any logged-in user (read-only included) can change their own password.
async function changePassword(req, res, _params, body) {
  const currentPassword = String((body && body.currentPassword) || "");
  const newPassword = String((body && body.newPassword) || "");
  if (!currentPassword || !newPassword) return sendJson(res, 400, { error: "Current and new password are required." });
  if (newPassword.length < 6) return sendJson(res, 400, { errors: ["New password must be at least 6 characters."] });

  const user = await queryOne("SELECT * FROM dbo.users WHERE id = @id", { id: req.user.id });
  if (!user || !auth.verifyPassword(currentPassword, user.password_hash)) {
    return sendJson(res, 401, { error: "Current password is incorrect." });
  }

  await query("UPDATE dbo.users SET password_hash = @passwordHash, updated_at = SYSUTCDATETIME() WHERE id = @id", {
    id: req.user.id,
    passwordHash: auth.hashPassword(newPassword),
  });
  sendJson(res, 200, { ok: true });
}

async function listUsers(req, res) {
  const { rows } = await query(
    "SELECT id, username, name, role, is_active, created_at FROM dbo.users ORDER BY username"
  );
  sendJson(res, 200, rows);
}

async function createUser(req, res, _params, body) {
  const { username, password, name, role, errors } = validateNewUser(body || {});
  if (errors.length) return sendJson(res, 400, { errors });

  try {
    const { id } = await queryOne(
      `INSERT INTO dbo.users (username, password_hash, name, role)
       OUTPUT INSERTED.id
       VALUES (@username, @passwordHash, @name, @role)`,
      { username, passwordHash: auth.hashPassword(password), name, role }
    );
    sendJson(res, 201, { id, username, name, role });
  } catch (err) {
    if (isUniqueViolation(err)) return sendJson(res, 409, { error: "That username is already taken." });
    throw err;
  }
}

async function updateUser(req, res, params, body) {
  const id = parseId(params.id);
  if (!id) return sendJson(res, 400, { error: "Invalid user id." });

  const existing = await queryOne("SELECT * FROM dbo.users WHERE id = @id", { id });
  if (!existing) return sendJson(res, 404, { error: "User not found." });

  const name = body.name !== undefined ? String(body.name).trim() : existing.name;
  const role = body.role !== undefined ? String(body.role) : existing.role;
  const isActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
  if (!name) return sendJson(res, 400, { errors: ["Name is required."] });
  if (!ROLES.has(role)) return sendJson(res, 400, { errors: ["Role must be 'read_only' or 'read_write'."] });
  if (!isActive && id === req.user.id) return sendJson(res, 400, { error: "You cannot deactivate your own account." });

  let passwordHash = existing.password_hash;
  if (body.password) {
    if (String(body.password).length < 6) return sendJson(res, 400, { errors: ["Password must be at least 6 characters."] });
    passwordHash = auth.hashPassword(String(body.password));
  }

  await query(
    `UPDATE dbo.users
        SET name = @name, role = @role, is_active = @isActive, password_hash = @passwordHash, updated_at = SYSUTCDATETIME()
      WHERE id = @id`,
    { id, name, role, isActive, passwordHash }
  );
  sendJson(res, 200, { id, username: existing.username, name, role, is_active: isActive });
}

async function removeUser(req, res, params) {
  const id = parseId(params.id);
  if (!id) return sendJson(res, 400, { error: "Invalid user id." });
  if (id === req.user.id) return sendJson(res, 400, { error: "You cannot delete your own account." });

  const { rowsAffected } = await query("DELETE FROM dbo.users WHERE id = @id", { id });
  if (!rowsAffected) return sendJson(res, 404, { error: "User not found." });
  res.writeHead(204).end();
}

function register(router) {
  router.post("/api/auth/login", login);
  router.post("/api/auth/logout", logout);
  router.get("/api/auth/me", me);
  router.put("/api/auth/me/password", changePassword);

  router.get("/api/auth/users", listUsers);
  router.post("/api/auth/users", createUser);
  router.put("/api/auth/users/:id", updateUser);
  router.delete("/api/auth/users/:id", removeUser);
}

module.exports = { register };
