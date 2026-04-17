# obsidian-react-graph-worker

Cloudflare Worker backend for obsidian-react-graph. Handles authentication, campaign access control, private GitHub reads, and GitHub commits. The React app never talks to GitHub directly; all reads and writes go through this Worker.

---

## Architecture

```
React App (Cloudflare Pages)
    │
    │  POST /login
    │  GET  /projects
    │  GET  /projects/:campaignId/auth/:token/*
    │  POST /save
    │  GET  /presence?campaignId=...
    │  POST /presence
  │  POST /webhooks/github
    ▼
Cloudflare Worker  ◄──── KV (passwords, ACL, sessions)
    │
    ├── GitHub Contents API (bot token)
    └── private file proxy for graph JSON + assets
        ▼
      GitHub private repo (campaign JSON files)
```

---

## Project Structure

```
obsidian-react-graph-worker/
├── src/
│   └── index.js          # Worker entrypoint — all endpoints
├── scripts/
│   ├── seed-kv.mjs       # One-time setup: write users + ACL to KV
│   └── add-user.mjs      # Add a new user without re-seeding
├── wrangler.toml         # Cloudflare config (worker name, KV bindings)
└── package.json
```

---

## KV Storage

KV namespace binding: APP_KV

| Key         | Value shape                                  | Description                      |
|-------------|----------------------------------------------|----------------------------------|
| `passwords` | `{ username: "pbkdf2:..." }`               | PBKDF2-hashed passwords per user |
| `acl`       | `{ campaignId: { username: ["read","write"] } }` | Per-campaign permissions per user |
| `sessions`  | `{ token: { username, expiresAt } }`         | Active session tokens            |

Passwords are hashed with PBKDF2 (SHA-256, 100k iterations) using the Web Crypto API, compatible with the Workers runtime.

Hash format: `pbkdf2:100000:<salt_hex>:<hash_hex>`

---

## API Endpoints

### `POST /login`
```json
// Request body
{ "username": "alice", "password": "changeme123" }

// Response (200)
{ "token": "<session_token>", "username": "alice" }

// Response (401)
{ "error": "Invalid credentials" }
```

### `GET /projects`
```
Authorization: Bearer <token>
```
```json
// Response (200) — only campaigns the user can access
{
  "graphs": [
    {
      "id": "ravenfall-campaign",
      "title": "Ravenfall: Crystal Heist",
      "permissions": ["read", "write"],
      "graphFile": "https://worker.example/projects/ravenfall-campaign/auth/<token>/obsidian-graph.json"
    }
  ]
}
```

The Worker rewrites `graphFile`, `metadataFile`, and `folder` so the front end uses authenticated Worker URLs instead of raw GitHub URLs.

### `GET /projects/:campaignId/auth/:token/*`
Private file proxy used by the front end for campaign JSON files and relative assets.

Example:
`/projects/ravenfall-campaign/auth/<token>/obsidian-graph.json`

The browser can fetch these URLs directly because access is enforced by the Worker.

### `POST /save`
```
Authorization: Bearer <token>
```
```json
// Request body
{ "campaignId": "ravenfall-campaign", "graphData": { ... } }

// Response (200)
{ "ok": true, "commit": "<commit_sha>" }

// Response (403)
{ "error": "Write access denied" }
```

### `GET /presence?campaignId=...`
Returns currently active editors for a campaign (heartbeat-based, short TTL) plus graph version metadata for lightweight client refresh decisions.

```json
// Response (200)
{
  "activeEditors": ["alice", "bob"],
  "graphUpdatedAt": 1713373200000,
  "graphUpdatedBy": "alice",
  "graphCommit": "<commit_sha>"
}
```

### `POST /presence`
Heartbeat endpoint to mark current user as actively editing a campaign.

```json
// Request body
{ "campaignId": "ravenfall-campaign" }

// Response (200)
{
  "ok": true,
  "campaignId": "ravenfall-campaign",
  "username": "alice",
  "activeEditors": ["alice", "bob"],
  "graphUpdatedAt": 1713373200000,
  "graphUpdatedBy": "alice",
  "graphCommit": "<commit_sha>"
}
```

### `POST /webhooks/github`
GitHub webhook endpoint with signature verification (`X-Hub-Signature-256`).

- Controlled by `ENABLE_GITHUB_WEBHOOKS`.
- Requires `GITHUB_WEBHOOK_SECRET`.
- Supports `ping` and `push` events (other events return `processed: false`).
- Deduplicates deliveries using `X-GitHub-Delivery` in KV (24h TTL).

```json
// Response (200)
{ "ok": true, "event": "push", "processed": true }

// Response (401)
{ "error": "Invalid webhook signature" }

// Response (403) when disabled
{ "error": "GitHub webhooks are disabled" }
```

---

## Environment Variables & Secrets

Set these in Cloudflare Worker settings or with Wrangler:

| Name            | Type   | Description                                |
|-----------------|--------|--------------------------------------------|
| `GITHUB_TOKEN`  | Secret | Bot token with write access to the target repo |
| `GITHUB_OWNER`  | Var    | GitHub user or org, e.g. `ErJaLo`          |
| `GITHUB_REPO`   | Var    | Repo name, e.g. `Roleplay-Library`         |
| `GITHUB_BRANCH` | Var    | Target branch, e.g. `main`                 |
| `ENABLE_GITHUB_WEBHOOKS` | Var | Enable webhook endpoint (`true`/`1` to enable, default disabled) |
| `GITHUB_WEBHOOK_SECRET` | Secret | Shared secret used to validate GitHub webhook signatures |

`GRAPHS_PATH` is no longer used in the current flow.

---

## Setup

### 1. Install Wrangler and authenticate

```bash
npm install -g wrangler
wrangler login
wrangler whoami  # verify
```

### 2. Verify KV bindings

`wrangler.toml` already binds APP_KV. If you need to change it, update the production and preview IDs in that file.

### 3. Seed KV (users + ACL)

Do not hardcode credentials in `scripts/seed-kv.mjs`.

Create local JSON files (recommended):

```json
// scripts/seed-users.local.json
{
  "alice": "<password>",
  "bob": "<password>"
}
```

```json
// scripts/seed-acl.local.json
{
  "ravenfall-campaign": {
    "alice": ["read", "write"],
    "bob": ["read"]
  }
}
```

Then run seeding with file env vars:

```bash
SEED_USERS_FILE=scripts/seed-users.local.json \
SEED_ACL_FILE=scripts/seed-acl.local.json \
node scripts/seed-kv.mjs
```

Or pass inline JSON env vars:

```bash
SEED_USERS_JSON='{"alice":"<password>"}' \
SEED_ACL_JSON='{"ravenfall-campaign":{"alice":["read","write"]}}' \
node scripts/seed-kv.mjs
```

Verify:

```bash
wrangler kv key get --remote --preview false --binding=APP_KV "passwords"
wrangler kv key get --remote --preview false --binding=APP_KV "acl"
```

### 4. Set secrets and vars

```bash
wrangler secret put GITHUB_TOKEN
```

Set these variables in Cloudflare Worker settings or via Wrangler environment config:

- `GITHUB_OWNER`
- `GITHUB_REPO`
- `GITHUB_BRANCH`
- `ENABLE_GITHUB_WEBHOOKS=true` (optional, required only if you want webhooks enabled)

Set webhook secret:

```bash
wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 5. Deploy

```bash
wrangler deploy
```

---

## Managing Users

### Add a new user

```bash
# Gives read access to specified campaigns
node scripts/add-user.mjs carol password456 ravenfall-campaign ironvale-intrigue
```

### Change permissions manually

Edit the `acl` key directly:

```bash
wrangler kv key get --remote --preview false --binding=APP_KV "acl"
# edit the JSON, then:
wrangler kv key put --remote --preview false --binding=APP_KV "acl" '<updated_json>'
```

---

## Notes

- The GitHub bot token is stored only in the Worker — never in the React app or repo.
- Reads are proxied through the Worker so the GitHub repo can stay private.
- The front end receives Worker URLs for campaign files and images, not GitHub raw URLs.
- All GitHub writes include the acting username in the commit message: `Update ravenfall-campaign (by alice)`.
- The GitHub Contents API requires the current file sha on updates — the Worker fetches it before each write.
- Successful saves also update per-campaign graph version metadata in KV (`updatedAt`, `updatedBy`, `commit`) used by presence responses.
- Sessions are stored in KV with an expiry timestamp. Expired tokens are rejected on each request.