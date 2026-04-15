const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function verifyPassword(plain, stored) {
  // stored format: "pbkdf2:<iterations>:<salt_hex>:<hash_hex>"
  const [, iterations, saltHex, hashHex] = stored.split(":");
  const enc = new TextEncoder();
  const toBytes = (hex) => new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));

  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(plain), "PBKDF2", false, ["deriveBits"]
  );
  const safeIterations = Math.min(parseInt(iterations, 10), 100_000);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toBytes(saltHex), iterations: safeIterations },
    keyMaterial, 256
  );
  const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return toHex(bits) === hashHex;
}

function generateToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

async function getSession(env, authHeader) {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const raw = await env.APP_KV.get("sessions");
  if (!raw) return null;
  const sessions = JSON.parse(raw);
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) return null;
  return session; // { username, expiresAt }
}

// ── Route Handlers ────────────────────────────────────────────────────────────

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { username, password } = body;
  if (!username || !password) return err("Missing username or password");

  const raw = await env.APP_KV.get("passwords");
  if (!raw) return err("Auth system unavailable", 500);
  const passwords = JSON.parse(raw);

  const stored = passwords[username];
  if (!stored) return err("Invalid credentials", 401);

  const valid = await verifyPassword(password, stored);
  if (!valid) return err("Invalid credentials", 401);

  // Create session (24h expiry)
  const token = generateToken();
  const expiresAt = Date.now() + 1000 * 60 * 60 * 24;

  const sessionsRaw = await env.APP_KV.get("sessions");
  const sessions = sessionsRaw ? JSON.parse(sessionsRaw) : {};
  sessions[token] = { username, expiresAt };
  await env.APP_KV.put("sessions", JSON.stringify(sessions));

  return json({ token, username });
}

async function handleProjects(request, env) {
  const session = await getSession(env, request.headers.get("Authorization"));
  if (!session) return err("Unauthorized", 401);

  // Read from env (local dev) or KV (production)
  const owner = env.GITHUB_OWNER || await env.APP_KV.get("config:github_owner");
  const repo = env.GITHUB_REPO || await env.APP_KV.get("config:github_repo");
  const branch = env.GITHUB_BRANCH || await env.APP_KV.get("config:github_branch");
  if (!owner || !repo || !branch) {
    return err("Server misconfigured: missing GITHUB_OWNER/REPO/BRANCH", 500);
  }

  let index;
  const indexRawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/index.json`;
  const rawRes = await fetch(indexRawUrl);
  if (rawRes.ok) {
    index = await rawRes.json();
  } else {
    const indexApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/index.json?ref=${branch}`;
    const indexRes = await fetch(indexApiUrl, {
      headers: {
        ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
        "User-Agent": "obsidian-worker",
      },
    });
    if (!indexRes.ok) {
      return err(`Could not load campaign index (raw:${rawRes.status}, api:${indexRes.status})`, 502);
    }
    const indexFile = await indexRes.json();
    index = JSON.parse(decodeURIComponent(escape(atob(indexFile.content))));
  }

  // Load ACL
  const aclRaw = await env.APP_KV.get("acl");
  const acl = aclRaw ? JSON.parse(aclRaw) : {};

  // Filter to campaigns this user can access
  const graphs = index.graphs
    .filter(g => acl[g.id]?.[session.username]?.length > 0)
    .map(g => ({
      ...g,
      permissions: acl[g.id][session.username],
    }));

  return json({ graphs });
}

async function handleSave(request, env) {
  const session = await getSession(env, request.headers.get("Authorization"));
  if (!session) return err("Unauthorized", 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON body");
  }

  const { campaignId, graphData } = body;
  if (!campaignId || !graphData) return err("Missing campaignId or graphData");

  // Check ACL — must have write permission
  const aclRaw = await env.APP_KV.get("acl");
  const acl = aclRaw ? JSON.parse(aclRaw) : {};
  const perms = acl[campaignId]?.[session.username] ?? [];
  if (!perms.includes("write")) return err("Write access denied", 403);

  // Build the file path in the repo
  const owner = env.GITHUB_OWNER || await env.APP_KV.get("config:github_owner");
  const repo = env.GITHUB_REPO || await env.APP_KV.get("config:github_repo");
  const branch = env.GITHUB_BRANCH || await env.APP_KV.get("config:github_branch");
  if (!owner || !repo || !branch) {
    return err("Server misconfigured: missing GITHUB_OWNER/REPO/BRANCH", 500);
  }
  const filePath = `${campaignId}/obsidian-graph.json`;
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

  // Get current file sha (required by GitHub API for updates)
  const getRes = await fetch(`${apiBase}?ref=${env.GITHUB_BRANCH}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "obsidian-worker",
    },
  });

  let sha;
  if (getRes.ok) {
    const fileInfo = await getRes.json();
    sha = fileInfo.sha;
  } else if (getRes.status !== 404) {
    return err("Failed to read file from GitHub", 502);
  }
  // 404 = file doesn't exist yet, sha stays undefined (first commit)

  // Encode content as base64
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(graphData, null, 2))));

  // Commit
  const putRes = await fetch(apiBase, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "obsidian-worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `Update ${campaignId} (by ${session.username})`,
      content,
      branch: env.GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putRes.ok) {
    const detail = await putRes.json();
    return err(`GitHub commit failed: ${detail.message}`, 502);
  }

  const result = await putRes.json();
  return json({ ok: true, commit: result.commit.sha });
}

// ── Main Router ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/login") {
      return handleLogin(request, env);
    }

    if (request.method === "GET" && url.pathname === "/projects") {
      return handleProjects(request, env);
    }

    if (request.method === "POST" && url.pathname === "/save") {
      return handleSave(request, env);
    }

    return err("Not found", 404);
  },
};