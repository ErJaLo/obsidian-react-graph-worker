# obsidian-react-graph-worker

Cloudflare Worker backend for `obsidian-react-graph`. Handles authentication, campaign access control, and GitHub commits. Users never touch GitHub directly — all writes go through this Worker using a bot token.

---

## Architecture

```
React App (Cloudflare Pages)
    │
    │  POST /login
    │  GET  /projects
    │  POST /save
    ▼
Cloudflare Worker  ◄──── KV (passwords, ACL, sessions)
    │
    │  GitHub Contents API (bot token)
    ▼
GitHub Repo (campaign JSON files)
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

KV namespace binding: `APP_KV`

| Key         | Value shape                                              | Description                        |
|-------------|----------------------------------------------------------|------------------------------------|
| `passwords` | `{ username: "pbkdf2:..." }`                             | PBKDF2-hashed passwords per user   |
| `acl`       | `{ campaignId: { username: ["read","write"] } }`         | Per-campaign permissions per user  |
| `sessions`  | `{ token: { username, expiresAt } }`                     | Active session tokens              |

Passwords are hashed with PBKDF2 (SHA-256, 100k iterations) using the Web Crypto API — compatible with the Workers runtime (no Node.js bcrypt).

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
      "permissions": ["read", "write"]
    }
  ]
}
```

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

---

## Environment Variables & Secrets

Set these in Cloudflare Worker settings (or `wrangler secret put`):

| Name             | Type   | Description                                     |
|------------------|--------|-------------------------------------------------|
| `GITHUB_TOKEN`   | Secret | Bot token with write access to the target repo  |
| `GITHUB_OWNER`   | Var    | GitHub user or org (e.g. `ErJaLo`)             |
| `GITHUB_REPO`    | Var    | Repo name (e.g. `Roleplay-Library`)             |
| `GITHUB_BRANCH`  | Var    | Target branch (e.g. `main`)                     |
| `GRAPHS_PATH`    | Var    | Path to campaign folder (e.g. `ravenfall-campaign`) |

---

## Setup

### 1. Install Wrangler and authenticate

```bash
npm install -g wrangler
wrangler login
wrangler whoami  # verify
```

### 2. Create KV namespaces

```bash
wrangler kv namespace create APP_KV
wrangler kv namespace create APP_KV --preview
```

Paste the returned IDs into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "APP_KV"
id = "PRODUCTION_ID"
preview_id = "PREVIEW_ID"
```

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

### 4. Set secrets

```bash
wrangler secret put GITHUB_TOKEN
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
- All GitHub writes include the acting username in the commit message: `Update ravenfall-campaign (by alice)`.
- The GitHub Contents API requires the current file `sha` on updates — the Worker fetches it before each write.
- Sessions are stored in KV with an expiry timestamp. Expired tokens are rejected on each request.