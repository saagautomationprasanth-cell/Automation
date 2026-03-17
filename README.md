# HideMyScreen

`HideMyScreen` is a lightweight, attended remote support MVP inspired by the basic flow of tools like TeamViewer:

- the host starts a session and gets a unique session ID
- the viewer joins with that session ID
- the host explicitly approves the request
- the host's browser shares its screen, and optionally its system audio, to the viewer over WebRTC
- the viewer can send short readable replies that appear in the host UI

This first version is intentionally small and safety-focused. It does **not** include unattended access, stealth installation, OS-level mouse/keyboard control, or file transfer.

## Tech stack

- `Node.js` built-in modules only for the HTTP server and signaling endpoints
- plain `HTML`, `CSS`, and browser `JavaScript`
- browser-native `WebRTC`, `WebSocket`, and `getDisplayMedia`

## Run it

1. Make sure `Node.js` 22 or later is installed.
2. Start the server:

```bash
node server.js
```

3. Open `http://localhost:3000` in two browser windows or on two different machines that can reach the host.
4. On the host side, click `Start host session`.
5. Leave `Include laptop audio` enabled if you want the viewer to hear supported system audio from the host machine.
6. Enter the session ID on the viewer side, then wait for approval.
7. The host clicks `Approve`, chooses which screen or window to share, and enables `Share audio` or `System audio` in the browser picker if available.
8. The viewer receives the stream and can use the `Reply feed` box to send readable text back to the host UI.

## Build a Windows EXE

This project can now be packaged into a single Windows executable with the static web files embedded inside it.

1. Make sure `Node.js` 22 or later is installed.
2. From the project folder, run:

```powershell
node scripts/build-exe.js
```

Or:

```powershell
npm.cmd run build:exe
```

3. The packaged file will be created at:

```text
dist/HideMyScreen.exe
```

Notes:

- The build script uses Node's official SEA packaging flow.
- The first build may download `postject` through `npx.cmd`.
- Double-clicking the packaged `.exe` starts the local server and opens the app in your default browser.

## Make it available on other systems

### On the same LAN

Start the server so it listens on your machine's network interface:

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "3000"
node server.js
```

Then find your local IP address and share:

```text
http://YOUR-LAN-IP:3000
```

You may also need to allow inbound traffic on port `3000` in the Windows firewall.

## Install on another laptop

1. Copy the whole project folder to the second laptop.
2. Install `Node.js` 22 or later on that laptop.
3. Open the project folder in a terminal.
4. Run:

```powershell
node server.js
```

5. Open the app in the browser on that laptop.

Because this project uses only built-in Node modules, there is no `npm install` step right now.

If you want the second laptop to use the packaged app instead of the source project, you can also copy only:

```text
dist/HideMyScreen.exe
```

Then double-click it on the second laptop. In that case, the other laptop does not need Node.js installed.

## Connect two installed copies with unique session IDs

There are two good ways to use two laptops:

### Option 1: simplest

- Run the server on laptop A only.
- From laptop B, open laptop A's URL directly, for example:

```text
http://192.168.1.43:3000
```

- Both laptops now use the same server, so session IDs are shared automatically.

### Option 2: install and run on both laptops

- Run this app on both laptops.
- In the `Shared Server` section at the top of the UI on both laptops, enter the same server URL.
- Example shared server URL:

```text
http://192.168.1.43:3000
```

- Click `Save shared server` on both machines.
- Start a host session on one laptop.
- Join from the other laptop using the generated session ID.

Important: if each laptop uses its own local server, they will create separate in-memory session lists and will not see each other's session IDs. Both copies must point to one common server.

### Over the internet

For users outside your local network, this MVP should be hosted on a machine with:

- a public IP address or domain name
- HTTPS in front of the app
- a TURN server for more reliable WebRTC connectivity

The client now loads ICE settings from the server at runtime, so you can configure STUN and TURN without changing browser code.

The safest pattern is to keep TURN provider credentials on the server only and let the browser fetch ICE settings from `/api/config`.

Example PowerShell environment setup:

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "3000"
$env:STUN_URLS = "stun:stun.l.google.com:19302"
$env:TURN_URLS = "turn:your-turn-server.example.com:3478"
$env:TURN_USERNAME = "your-username"
$env:TURN_PASSWORD = "your-password"
node server.js
```

Or use one JSON variable:

```powershell
$env:ICE_SERVERS = '[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:your-turn-server.example.com:3478","username":"your-username","credential":"your-password"}]'
node server.js
```

### Public TURN provider: Twilio

If you use Twilio Network Traversal Service, the server can fetch fresh TURN credentials for clients at runtime.

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "3000"
$env:ICE_PROVIDER = "twilio"
$env:TWILIO_ACCOUNT_SID = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
$env:TWILIO_AUTH_TOKEN = "your-twilio-auth-token"
$env:TWILIO_TURN_TTL = "3600"
node server.js
```

Optional:

- `TWILIO_TURN_REGION` to pin `global.twilio.com` URLs to a region such as `us1` when needed
- `STUN_URLS` or `ICE_SERVERS` as a fallback if the provider cannot be reached

### Public TURN provider: Metered

If you use Metered, the server can request TURN credentials from your Metered app and cache them.

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "3000"
$env:ICE_PROVIDER = "metered"
$env:METERED_APP_NAME = "your-metered-app-name"
$env:METERED_API_KEY = "your-metered-api-key"
$env:METERED_REGION = "global"
node server.js
```

Optional:

- `METERED_CACHE_TTL_MS` to control how long the server caches Metered credentials before refreshing
- `STUN_URLS` or `ICE_SERVERS` as a fallback if the provider cannot be reached

### Render environment example

On Render, add these environment variables to your service instead of hard-coding ICE values in the frontend.

Twilio example:

```text
HOST=0.0.0.0
PORT=10000
ICE_PROVIDER=twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_TURN_TTL=3600
```

Metered example:

```text
HOST=0.0.0.0
PORT=10000
ICE_PROVIDER=metered
METERED_APP_NAME=your-metered-app-name
METERED_API_KEY=your-metered-api-key
METERED_REGION=global
```

## Notes

- `getDisplayMedia` is user-consent based and works best on `localhost` or HTTPS.
- System audio availability depends on the browser, operating system, and the screen or tab chosen in the share picker.
- The readable reply feed appears in the host UI. To let the other person read it directly, keep the host app visible in the shared screen or shared window.
- The MVP supports one active viewer at a time.
- A public Google STUN server is included for basic NAT traversal. Real internet-scale deployment usually needs TURN as well.
- The server now supports provider-backed TURN credentials for Twilio and Metered, while keeping static `ICE_SERVERS`, `STUN_URLS`, and `TURN_*` values as a fallback.
- Sessions are stored in memory, so restarting the server clears all active sessions.
- Real-time signaling now uses WebSockets. Session creation and join still start over normal HTTP endpoints.
- This is still an MVP, not a production-hardened remote support service. It needs authentication, rate limiting, audit logging, and persistent storage before wider public use.

## Suggested next steps

If you want this to get closer to a true remote support product, the next safe improvements would be:

1. move signaling state into a persistent store so sessions survive server restarts
2. add authenticated accounts and invitation links
3. add TURN for more reliable connectivity
4. add end-to-end encryption metadata and audit logs
5. build a separate, reviewed native helper for optional attended remote input control
