const os = require("node:os");

// Each user runs this app locally (see run.bat), so the OS account name of
// the running process is that person's Windows login -- a free way to trace
// who wrote a comment without needing a login screen.
function getOsUsername() {
  try {
    const name = os.userInfo().username;
    if (name) return name;
  } catch {}
  return process.env.USERNAME || process.env.USER || null;
}

// Who to stamp created_by/updated_by/changed_by with: the logged-in user's name takes
// priority now that /api/* requires authentication, with the old fallbacks kept for safety.
function resolveChangedBy(req, fallback) {
  return (req.user && req.user.name) || fallback || req.headers["x-user"] || getOsUsername();
}

module.exports = { getOsUsername, resolveChangedBy };


