# Deploying ITRM Tracker on IIS (development server)

IIS cannot run a Node.js app by itself, so the setup is:

```
Browser --> IIS site (port 80/8080, web.config) --reverse proxy--> Node app (127.0.0.1:3000) --> SQL Server
```

- **IIS** = the public front door (URL Rewrite + ARR proxy, configured by [web.config](./web.config)).
- **Node** = runs in the background as a startup task ([deploy/install-service.ps1](./deploy/install-service.ps1)).
- The app must be served at the **root of its own IIS site** (its frontend calls `/api/...`), not as a sub-application like `/itrm`.

## Step 1 - Prerequisites on the IIS server
1. Windows Server with admin rights.
2. Node.js 22.5+ - either install it, or keep the bundled `node-v24.19.0-win-x64` folder when copying the app (the script uses it automatically).
3. Network access from this server to SQL Server (`SQL_SERVER`:1433 in `.env`). Test:
   `Test-NetConnection <sql-server-ip> -Port 1433`

## Step 2 - Install IIS
Administrator PowerShell:
```powershell
Install-WindowsFeature Web-Server -IncludeManagementTools
```
(Or Server Manager > Add Roles and Features > Web Server (IIS).)

## Step 3 - Install the two IIS add-ons (needed for the proxy)
Download and install, in this order (installers from iis.net / Microsoft):
1. **URL Rewrite** module (`rewrite_amd64_en-US.msi`)
2. **Application Request Routing (ARR) 3.0** (`requestRouter_amd64.msi`)

Then enable the proxy: open **IIS Manager > click the server name (top node) > Application Request Routing Cache > Server Proxy Settings (right pane) > tick "Enable proxy" > Apply.**
Close and reopen IIS Manager if the icon doesn't appear.

## Step 4 - Copy the app to the server
Copy the whole project folder to e.g. `C:\inetpub\itrm-tracker` (include `web.config`, `deploy\`, and `node_modules`/the bundled Node folder if the server has no internet; **do not** copy `data\*.db`, it is the old SQLite file).

Create `C:\inetpub\itrm-tracker\.env` from `.env.example`:
```
SQL_SERVER=...
SQL_PORT=1433
SQL_DATABASE=ITRM
SQL_USER=...
SQL_PASSWORD=...
SQL_ENCRYPT=true
SQL_TRUST_SERVER_CERTIFICATE=true
PORT=3000
```
Keep `COOKIE_SECURE` unset while you use plain `http://`; set `COOKIE_SECURE=true` only after you add HTTPS (otherwise login will silently fail).

Install dependencies (skip if you copied `node_modules`):
```powershell
cd C:\inetpub\itrm-tracker
npm install --omit=dev
```
(With the bundled Node: `.\node-v24.19.0-win-x64\npm.cmd install --omit=dev`.)

## Step 5 - Test Node by itself first
```powershell
cd C:\inetpub\itrm-tracker
node db\seed.js     # creates tables / seeds lookups + the first admin user
node server.js
```
In another window: `curl.exe http://127.0.0.1:3000/healthz` must return `{"ok":true}`. Stop it with Ctrl+C.
If it fails, the problem is the `.env` / SQL connection, not IIS.

## Step 6 - Run Node automatically in the background
Elevated PowerShell:
```powershell
cd C:\inetpub\itrm-tracker
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\install-service.ps1 -AppPath C:\inetpub\itrm-tracker
curl.exe http://127.0.0.1:3000/healthz
```
This creates the scheduled task `ITRM-Tracker-Node` (starts at boot, restarts on failure, logs to `logs\app.log`).
Update later: `Stop-ScheduledTask ITRM-Tracker-Node; <copy new files>; Start-ScheduledTask ITRM-Tracker-Node`.

## Step 7 - Create the IIS site
IIS Manager > **Sites > Add Website**:
- Site name: `ITRM-Tracker`
- Physical path: `C:\inetpub\itrm-tracker`
- Binding: HTTP, port `8080` (or 80 after stopping/removing "Default Web Site"), optional host name e.g. `itrm-dev.yourdomain.local`.

Or PowerShell:
```powershell
Import-Module WebAdministration
New-Website -Name ITRM-Tracker -PhysicalPath C:\inetpub\itrm-tracker -Port 8080
```
The site's application pool can stay on the default (No Managed Code); it only reads `web.config`.
Give the pool read access: `icacls C:\inetpub\itrm-tracker /grant "IIS_IUSRS:(OI)(CI)RX"`

## Step 8 - Open the firewall and test
```powershell
New-NetFirewallRule -DisplayName "ITRM Tracker 8080" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
```
Do **not** open port 3000; only IIS should reach Node.

Browse to `http://<server-name>:8080/` and log in (first-time admin credentials are from `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`, default in `db/seed.js`; change the password right away).

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| HTTP 500.19 (config error) | URL Rewrite not installed, or `web.config` malformed. |
| HTTP 502 / 502.3 | Node isn't running or port mismatch. Check `curl http://127.0.0.1:3000/healthz`, `logs\app.log`, `Get-ScheduledTask ITRM-Tracker-Node`. |
| HTTP 404 from IIS on every URL | Proxy not enabled in ARR (Step 3) or the rule isn't loading. |
| Login "works" but you are bounced back | `COOKIE_SECURE=true` while using HTTP. Remove it or use HTTPS. |
| Import of large file fails with 404.13 | `maxAllowedContentLength` in `web.config` too small. |
| Node app exits at start | SQL unreachable / wrong credentials in `.env` (see `logs\app.log`). |

## Security notes
- `.env.example` currently contains what looks like a real DB host/user/password. Replace those with placeholders and rotate the password if it is real.
- Add HTTPS (IIS Manager > Bindings > add `https` with a certificate), then set `COOKIE_SECURE=true` and restart the task.
- Don't expose the `.env`/`data`/`db` folders: the proxy rule sends everything to Node (which only serves `public\`), so they are not reachable over HTTP.
