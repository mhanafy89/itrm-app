# ITRM Business Request Tracker

A small self-hosted web app that replaces the Excel tracker with a shared
input form + database, so multiple people can add/edit business requests at
the same time without file-locking or merge conflicts.

It runs on Node's built-in `http` module plus the `mssql` driver, with
Microsoft SQL Server as the database.

## What's inside

- `server.js` -- the HTTP server (routing, static file serving)
- `db/database.js` -- SQL Server connection pool, parameterized query helper, transactions
- `db/schema.sql` -- T-SQL table definitions (idempotent; run automatically on start, or by hand with sqlcmd/SSMS)
- `db/seed.js` -- seeds the dropdown/lookup tables with the same values that were in the Excel Lookups sheet
- `db/migrate-from-sqlite.js` -- one-time copy of an existing SQLite database into SQL Server
- `routes/businessRequests.js`, `routes/incidents.js`, `routes/lookups.js` -- the API
- `routes/validation.js` -- server-side validation (title required, dates must be real dates, and the same "two-sided" chronological check the Excel version had: each pipeline date must be on/after the stage before it and on/before the stage after it, skipping any neighbor that's still blank)
- `public/` -- the frontend: one page, a table of requests, and a slide-over form for adding/editing (plain HTML/CSS/JS, no framework/build step)

## Requirements

- **Node.js 22.5 or later**. Check with `node -v`.
- **Microsoft SQL Server 2017 or later** (Express is fine) reachable over TCP, with a login that can create
  tables in the target database (`db_owner` on it is simplest). If you set `SQL_CREATE_DATABASE=true` the login
  also needs `CREATE DATABASE`; otherwise create an empty database first.

## Configuration

Copy `.env.example` to `.env` (git-ignored) or set real environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `SQL_SERVER` | Host name (or `HOST\INSTANCE`) | `localhost` |
| `SQL_PORT` | TCP port | `1433` |
| `SQL_DATABASE` | Database name | `itrm_tracker` |
| `SQL_USER` / `SQL_PASSWORD` | SQL authentication login | required |
| `SQL_ENCRYPT` | TLS to the server | `true` |
| `SQL_TRUST_SERVER_CERTIFICATE` | Accept a self-signed certificate | `false` |
| `SQL_CREATE_DATABASE` | Create the database on start if missing | `false` |
| `SQL_POOL_MAX` | Max pooled connections | `10` |

Windows authentication is optional: `npm install msnodesqlv8` and set `SQL_TRUSTED_CONNECTION=true`
(plus `SQL_ODBC_DRIVER` if needed).

## Running it locally

```bash
npm install
npm run seed    # creates the tables (if missing) and populates the dropdown lists
npm start        # starts the server on http://localhost:3000
```

Open http://localhost:3000 in a browser. Back up the SQL Server database with your usual SQL Server backups.

Log in with the default account created by `npm run seed` the first time it runs:
`admin` / `admin123` (override with `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`
in `.env`). Change that password and add real accounts via the `/api/auth/users`
API (see routes/auth.js) -- there's no settings UI for it yet. Every account is
either `read_only` (can view everything) or `read_write` (can also create,
edit, delete and import); the server rejects write requests from read-only
accounts even if someone calls the API directly.

### Migrating an existing SQLite database

```bash
npm run migrate:sqlite -- data/itrm_tracker.db --dry-run   # copy + validate, then roll back
npm run migrate:sqlite -- data/itrm_tracker.db             # real run (target tables must be empty)
```

Run it **before** `npm run seed`/starting the app (or add `--truncate` to replace what is there). ids are
preserved, everything happens in one transaction, and row counts plus id checksums are compared per table
before commit. To create the schema by hand instead, run `db/schema.sql` with `sqlcmd -d <database> -i db/schema.sql`.

## Deploying it so your team can share it

You need this running on a machine/server that's reachable by everyone who'll
use it (a company VM, an internal server, or a small cloud host). Three ways
to do that, in increasing order of "hands-off":

### 1. Plain Node, on any server with Node 22.5+
```bash
git clone <wherever you put this> itrm-tracker-app
cd itrm-tracker-app
npm install --omit=dev
# create .env with the SQL_* settings
npm run seed
PORT=3000 npm start
```
Put a process manager in front of it (e.g. `pm2 start server.js` or a systemd
unit) so it restarts automatically and survives reboots. Put it behind a
reverse proxy (nginx/Caddy) if you want HTTPS and a real domain name.

### 2. Docker (recommended -- simplest to keep running reliably)
```bash
# .env next to docker-compose.yml:  SQL_PASSWORD=<strong password>
docker compose up -d --build
```
This starts a SQL Server 2022 container (data in the `itrm-sqldata` volume) and the app, which creates and
seeds the database on first boot. To use an existing SQL Server instead, remove the `sqlserver` service and
point the `SQL_*` variables at it.

### 3. A managed platform (Render, Railway, Fly.io, an internal PaaS, etc.)
Point it at this repo/Dockerfile and set the `SQL_*` environment variables to a reachable SQL Server /
Azure SQL database.

## Concurrency & data integrity

SQL Server handles concurrent readers and writers natively. Each create/update/delete (record + audit-trail
row) runs in a single transaction, so several people editing at the same time will not corrupt data.

Every create/update/delete is also logged to `business_request_history` with
a timestamp (and `changed_by`, if you wire up who's making the change -- see
"Adding real user identity" below), so you have a full audit trail of who
changed what and when, which the Excel version didn't have.

## Adding real user identity / login

Right now anyone who can reach the app can add/edit/delete records, and
`changed_by` is only populated if the frontend sends an `X-User` header (it
currently doesn't -- there's no login screen). Before rolling this out beyond
a small trusted team, you'll want to add authentication. Options, roughly in
order of effort:
- Put it behind your company VPN/internal network only (no code changes)
- Add a simple shared password gate (a few lines of middleware)
- Wire up real accounts (e.g. your company's SSO/OAuth provider)

## API

All endpoints return/accept JSON.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/business-requests` | List all requests (includes joined lookup names) |
| GET | `/api/business-requests/:id` | One request |
| POST | `/api/business-requests` | Create. Body = full record. Returns 400 with `{errors:[...]}` on validation failure |
| PUT | `/api/business-requests/:id` | **Full replace**, not a partial patch -- send every field, not just the ones you changed (the frontend form always does this) |
| DELETE | `/api/business-requests/:id` | Delete |
| GET | `/api/business-requests/:id/history` | Audit trail for one record |
| GET | `/api/lookups` | All dropdown lists at once (`business-units`, `priorities`, `stages`, `statuses`, `tech-owners`, `regulators`) |
| POST | `/api/lookups/:type` | Add a new dropdown value, e.g. a new regulator: `{"name": "SAMA"}` |
| DELETE | `/api/lookups/:type/:id` | Remove a dropdown value (blocked with 409 if any request still uses it) |

## Migrating your existing Excel data in

There's no automatic importer yet. For a one-time migration from the
`ITRM_Tracker.xlsx` file: export each column to match the field names in
`db/schema.sql`, look up the id for each dropdown value (`GET /api/lookups`
will give you the ids), and either `POST` each row through the API with a
small script, or insert directly into the SQL Server database with any SQL
tool (e.g. SSMS or Azure Data Studio). Ask if you'd like a ready-made import
script for this -- it's a quick add-on once you tell me where the server will
actually run.

## A note on the spelling in the lookup lists

A few values carry over the original spelling from the Excel Lookups sheet
("Critcal", "Compeleted") rather than "fixing" it, since your linked master
tracker already uses that spelling elsewhere. Edit the rows in `priorities`
/ `statuses` (or use `POST/DELETE /api/lookups/...`) if you'd rather
standardize it going forward.
