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

function getGithubConfig(env) {
  const owner = env.GITHUB_OWNER || null;
  const repo = env.GITHUB_REPO || null;
  const branch = env.GITHUB_BRANCH || null;

  return { owner, repo, branch };
}

function getWorkerBaseUrl(request) {
  return new URL(request.url).origin;
}

function isGithubWebhookEnabled(env) {
  const value = String(env.ENABLE_GITHUB_WEBHOOKS ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeHexEqual(leftHex, rightHex) {
  if (typeof leftHex !== 'string' || typeof rightHex !== 'string') return false;
  if (leftHex.length !== rightHex.length) return false;
  let mismatch = 0;
  for (let i = 0; i < leftHex.length; i += 1) {
    mismatch |= leftHex.charCodeAt(i) ^ rightHex.charCodeAt(i);
  }
  return mismatch === 0;
}

async function computeHmacSha256Hex(secret, payloadText) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadText));
  return bytesToHex(new Uint8Array(signature));
}

async function verifyGithubWebhookSignature(payloadText, signatureHeader, secret) {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false;
  if (!signatureHeader.startsWith('sha256=')) return false;
  const receivedHex = signatureHeader.slice('sha256='.length).trim().toLowerCase();
  if (!receivedHex) return false;
  const expectedHex = await computeHmacSha256Hex(secret, payloadText);
  return timingSafeHexEqual(receivedHex, expectedHex);
}

const CANVAS_STATE_KV_PREFIX = "canvas-state:";
const WEBHOOK_DELIVERY_KV_PREFIX = 'webhook-delivery:';
const WEBHOOK_DELIVERY_TTL_SECONDS = 60 * 60 * 24;
const EDITOR_PRESENCE_KV_PREFIX = 'editor-presence:';
const EDITOR_PRESENCE_TTL_SECONDS = 90;
const GRAPH_VERSION_KV_PREFIX = 'graph-version:';

function getCanvasStateKey(campaignId) {
  return `${CANVAS_STATE_KV_PREFIX}${campaignId}`;
}

function getWebhookDeliveryKey(deliveryId) {
  return `${WEBHOOK_DELIVERY_KV_PREFIX}${deliveryId}`;
}

function getEditorPresenceKey(campaignId, username) {
  return `${EDITOR_PRESENCE_KV_PREFIX}${campaignId}`;
}

function getGraphVersionKey(campaignId) {
  return `${GRAPH_VERSION_KV_PREFIX}${campaignId}`;
}

async function readGraphVersion(env, campaignId) {
  const raw = await env.APP_KV.get(getGraphVersionKey(campaignId));
  if (!raw) return { updatedAt: 0, updatedBy: null, commit: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      updatedAt: isFiniteNumber(parsed?.updatedAt) ? parsed.updatedAt : 0,
      updatedBy: typeof parsed?.updatedBy === 'string' ? parsed.updatedBy : null,
      commit: typeof parsed?.commit === 'string' ? parsed.commit : null,
    };
  } catch {
    return { updatedAt: 0, updatedBy: null, commit: null };
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeCanvasState(input) {
  if (!input || typeof input !== 'object') return null;

  const positions = {};
  if (input.positions && typeof input.positions === 'object') {
    for (const [nodeId, value] of Object.entries(input.positions)) {
      if (typeof nodeId !== 'string' || !nodeId.trim()) continue;
      if (!value || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) continue;
      positions[nodeId] = { x: value.x, y: value.y };
    }
  }

  const viewport = input.viewport && typeof input.viewport === 'object'
    ? {
        ...(isFiniteNumber(input.viewport.x) ? { x: input.viewport.x } : {}),
        ...(isFiniteNumber(input.viewport.y) ? { y: input.viewport.y } : {}),
        ...(isFiniteNumber(input.viewport.zoom) ? { zoom: input.viewport.zoom } : {}),
      }
    : null;

  return {
    positions,
    ...(viewport && Object.keys(viewport).length > 0 ? { viewport } : {}),
    updatedAt: Date.now(),
  };
}

function getCanvasStateSignature(canvasState) {
  if (!canvasState || typeof canvasState !== 'object') return '';
  const positions = canvasState.positions && typeof canvasState.positions === 'object' ? canvasState.positions : {};
  const viewport = canvasState.viewport && typeof canvasState.viewport === 'object' ? canvasState.viewport : null;

  const positionEntries = Object.entries(positions)
    .filter(([, value]) => isFiniteNumber(value?.x) && isFiniteNumber(value?.y))
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([nodeId, value]) => [nodeId, Number(value.x.toFixed(3)), Number(value.y.toFixed(3))]);

  return JSON.stringify({
    positions: positionEntries,
    viewport: viewport ? {
      ...(isFiniteNumber(viewport.x) ? { x: Number(viewport.x.toFixed(3)) } : {}),
      ...(isFiniteNumber(viewport.y) ? { y: Number(viewport.y.toFixed(3)) } : {}),
      ...(isFiniteNumber(viewport.zoom) ? { zoom: Number(viewport.zoom.toFixed(3)) } : {}),
    } : null,
  });
}

async function readCanvasState(env, campaignId) {
  const raw = await env.APP_KV.get(getCanvasStateKey(campaignId));
  if (!raw) return { positions: {}, viewport: null, updatedAt: null };

  try {
    const parsed = JSON.parse(raw);
    const normalized = normalizeCanvasState(parsed);
    return normalized || { positions: {}, viewport: null, updatedAt: null };
  } catch {
    return { positions: {}, viewport: null, updatedAt: null };
  }
}

function toProxyPath(pathname, baseUrl) {
  const normalized = pathname
    .replace(/\\/g, '/')
    .replace(/^\.?\/?/, '')
    .replace(/^\/+/, '');

  const proxyPath = `${baseUrl}/projects/${normalized}`;

  if (pathname.endsWith('/')) {
    return `${proxyPath}/`;
  }

  return proxyPath;
}

function rewriteGraphDescriptor(graph, baseUrl, authToken) {
  const rewrite = (value, keepDirectorySlash = false) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return value;
    }

    const trimmed = value.trim();

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }

    const proxied = new URL(toProxyPath(trimmed, baseUrl));

    if (authToken) {
      const match = proxied.pathname.match(/^\/projects\/([^/]+)(?:\/(.*))?$/);
      if (match) {
        const campaignId = match[1];
        const rest = match[2] || '';
        proxied.pathname = `/projects/${campaignId}/auth/${authToken}/${rest}`.replace(/\/+/g, '/');
      }
    }

    if (keepDirectorySlash && !proxied.pathname.endsWith('/')) {
      proxied.pathname += '/';
    }

    return proxied.toString();
  };

  return {
    ...graph,
    folder: rewrite(graph.folder, true),
    metadataFile: rewrite(graph.metadataFile),
    graphFile: rewrite(graph.graphFile),
  };
}

function inferContentType(filePath) {
  const lower = filePath.toLowerCase();

  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv') || lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    return 'text/plain; charset=utf-8';
  }

  return 'application/octet-stream';
}

function decodeBase64Content(content) {
  const binary = atob(content.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function loadCampaignIndex(env, owner, repo, branch) {
  const indexRawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/index.json`;
  const rawRes = await fetch(indexRawUrl);
  if (rawRes.ok) {
    return { index: await rawRes.json(), source: 'raw', rawStatus: rawRes.status };
  }

  const indexApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/index.json?ref=${encodeURIComponent(branch)}`;
  const indexRes = await fetch(indexApiUrl, {
    headers: {
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      "User-Agent": "obsidian-worker",
    },
  });

  if (!indexRes.ok) {
    return { index: null, source: 'api', rawStatus: rawRes.status, apiStatus: indexRes.status };
  }

  const indexFile = await indexRes.json();
  return {
    index: JSON.parse(decodeURIComponent(escape(atob(indexFile.content)))),
    source: 'api',
    rawStatus: rawRes.status,
    apiStatus: indexRes.status,
  };
}

async function getCampaignAcl(env) {
  const aclRaw = await env.APP_KV.get("acl");
  return aclRaw ? JSON.parse(aclRaw) : {};
}

async function getSessionByToken(env, token) {
  if (!token) return null;

  const raw = await env.APP_KV.get("sessions");
  if (!raw) return null;

  const sessions = JSON.parse(raw);
  const session = sessions[token];
  if (!session) return null;
  if (Date.now() > session.expiresAt) return null;

  return { ...session, token };
}

async function handleProjectFile(request, env, campaignId, authToken, fileSegments) {
  const session = authToken
    ? await getSessionByToken(env, authToken)
    : await getSession(env, request.headers.get("Authorization"));
  if (!session) return err("Unauthorized", 401);

  const acl = await getCampaignAcl(env);
  const perms = acl[campaignId]?.[session.username] ?? [];
  if (perms.length === 0) return err("Forbidden", 403);

  const relativePath = fileSegments.join("/");
  if (!relativePath || relativePath.includes("..")) {
    return err("Invalid file path", 400);
  }

  const owner = env.GITHUB_OWNER || await env.APP_KV.get("config:github_owner");
  const repo = env.GITHUB_REPO || await env.APP_KV.get("config:github_repo");
  const branch = env.GITHUB_BRANCH || await env.APP_KV.get("config:github_branch");
  if (!owner || !repo || !branch) {
    return err("Server misconfigured: missing GITHUB_OWNER/REPO/BRANCH", 500);
  }

  const filePath = `${campaignId}/${relativePath}`;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(apiUrl, {
    headers: {
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      "User-Agent": "obsidian-worker",
    },
  });

  if (!res.ok) {
    return err(`Could not load ${relativePath}`, res.status === 404 ? 404 : 502);
  }

  const fileInfo = await res.json();
  if (fileInfo?.encoding !== 'base64' || typeof fileInfo.content !== 'string') {
    return err(`Unsupported response for ${relativePath}`, 502);
  }

  const body = decodeBase64Content(fileInfo.content);
  return new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": inferContentType(relativePath),
      "Cache-Control": "private, max-age=60",
    },
  });
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
  return { ...session, token }; // { username, expiresAt, token }
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

  const indexResult = await loadCampaignIndex(env, owner, repo, branch);
  if (!indexResult.index) {
    return err(`Could not load campaign index (raw:${indexResult.rawStatus}, api:${indexResult.apiStatus ?? 'n/a'})`, 502);
  }

  const index = indexResult.index;
  const workerBaseUrl = getWorkerBaseUrl(request);

  // Load ACL
  const acl = await getCampaignAcl(env);

  // Filter to campaigns this user can access
  const graphs = index.graphs
    .filter(g => acl[g.id]?.[session.username]?.length > 0)
    .map(g => ({
      ...rewriteGraphDescriptor(g, workerBaseUrl, session.token),
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
  const apiFilePath = filePath.split('/').map(encodeURIComponent).join('/');
  const apiBase = `https://api.github.com/repos/${owner}/${repo}/contents/${apiFilePath}`;

  const githubHeaders = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "obsidian-worker",
    "Content-Type": "application/json",
  };

  const getCurrentSha = async () => {
    const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "User-Agent": "obsidian-worker",
      },
    });

    if (getRes.ok) {
      const fileInfo = await getRes.json();
      return { sha: fileInfo.sha, notFound: false };
    }

    if (getRes.status === 404) {
      return { sha: undefined, notFound: true };
    }

    return { sha: null, notFound: false };
  };

  // Encode content as base64
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(graphData, null, 2))));

  const commitGraph = async (sha) => fetch(apiBase, {
    method: "PUT",
    headers: githubHeaders,
    body: JSON.stringify({
      message: `Update ${campaignId} (by ${session.username})`,
      content,
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  const firstShaState = await getCurrentSha();
  if (firstShaState.sha === null) {
    return err("Failed to read file from GitHub", 502);
  }

  let putRes = await commitGraph(firstShaState.sha);

  if (!putRes.ok) {
    let detail;
    try {
      detail = await putRes.json();
    } catch {
      detail = null;
    }

    const message = detail?.message || "GitHub commit failed";
    const isShaConflict = putRes.status === 409 || /expected|sha/i.test(message);

    if (isShaConflict) {
      const retryShaState = await getCurrentSha();
      if (retryShaState.sha === null) {
        return err("Failed to refresh file SHA from GitHub", 502);
      }

      putRes = await commitGraph(retryShaState.sha);

      if (!putRes.ok) {
        let retryDetail;
        try {
          retryDetail = await putRes.json();
        } catch {
          retryDetail = null;
        }
        return err(`GitHub commit failed: ${retryDetail?.message || message}`, 502);
      }
    } else {
      return err(`GitHub commit failed: ${message}`, 502);
    }
  }

  const result = await putRes.json();
  await env.APP_KV.put(
    getGraphVersionKey(campaignId),
    JSON.stringify({
      updatedAt: Date.now(),
      updatedBy: session.username,
      commit: result?.commit?.sha || null,
    }),
  );
  return json({ ok: true, commit: result.commit.sha });
}

async function handleGetCanvasState(request, env) {
  const session = await getSession(env, request.headers.get('Authorization'));
  if (!session) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const campaignId = url.searchParams.get('campaignId');
  if (!campaignId) return err('Missing campaignId');

  const acl = await getCampaignAcl(env);
  const perms = acl[campaignId]?.[session.username] ?? [];
  if (perms.length === 0) return err('Forbidden', 403);

  const canvasState = await readCanvasState(env, campaignId);
  return json({ campaignId, canvasState });
}

async function handleSaveCanvasState(request, env) {
  const session = await getSession(env, request.headers.get('Authorization'));
  if (!session) return err('Unauthorized', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { campaignId, canvasState } = body;
  if (!campaignId || !canvasState) return err('Missing campaignId or canvasState');

  const acl = await getCampaignAcl(env);
  const perms = acl[campaignId]?.[session.username] ?? [];
  if (!perms.includes('write')) return err('Write access denied', 403);

  const normalizedIncoming = normalizeCanvasState(canvasState);
  if (!normalizedIncoming) return err('Invalid canvasState payload');

  const current = await readCanvasState(env, campaignId);
  if (getCanvasStateSignature(current) === getCanvasStateSignature(normalizedIncoming)) {
    return json({ ok: true, campaignId, canvasState: current, skipped: true });
  }

  const merged = {
    ...current,
    positions: {
      ...(current?.positions || {}),
      ...(normalizedIncoming.positions || {}),
    },
    ...(normalizedIncoming.viewport ? { viewport: normalizedIncoming.viewport } : {}),
    updatedAt: Date.now(),
    savedBy: session.username,
  };

  await env.APP_KV.put(getCanvasStateKey(campaignId), JSON.stringify(merged));

  return json({ ok: true, campaignId, canvasState: merged });
}

async function handleGetEditorPresence(request, env) {
  const session = await getSession(env, request.headers.get('Authorization'));
  if (!session) return err('Unauthorized', 401);

  const url = new URL(request.url);
  const campaignId = url.searchParams.get('campaignId');
  if (!campaignId) return err('Missing campaignId');

  const acl = await getCampaignAcl(env);
  const perms = acl[campaignId]?.[session.username] ?? [];
  if (perms.length === 0) return err('Forbidden', 403);

  const raw = await env.APP_KV.get(getEditorPresenceKey(campaignId));
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  const activeEditors = [];
  const now = Date.now();
  if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object') {
    for (const [username, meta] of Object.entries(parsed.users)) {
      if (!username || username === session.username) continue;
      if (!meta || !isFiniteNumber(meta.updatedAt)) continue;
      if ((now - meta.updatedAt) > EDITOR_PRESENCE_TTL_SECONDS * 1000) continue;
      activeEditors.push(username);
    }
  }

  const graphVersion = await readGraphVersion(env, campaignId);

  return json({
    campaignId,
    activeEditors: [...new Set(activeEditors)],
    me: session.username,
    graphUpdatedAt: graphVersion.updatedAt,
    graphUpdatedBy: graphVersion.updatedBy,
    graphCommit: graphVersion.commit,
  });
}

async function handleSaveEditorPresence(request, env) {
  const session = await getSession(env, request.headers.get('Authorization'));
  if (!session) return err('Unauthorized', 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return err('Invalid JSON body');
  }

  const { campaignId } = body || {};
  if (!campaignId) return err('Missing campaignId');

  const acl = await getCampaignAcl(env);
  const perms = acl[campaignId]?.[session.username] ?? [];
  if (perms.length === 0) return err('Forbidden', 403);

  const key = getEditorPresenceKey(campaignId, session.username);
  let current = { campaignId, users: {} };
  const raw = await env.APP_KV.get(key);
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && parsed.users && typeof parsed.users === 'object') {
      current = {
        campaignId: parsed.campaignId || campaignId,
        users: parsed.users,
      };
    }
  } catch {
    current = { campaignId, users: {} };
  }

  current.users[session.username] = { updatedAt: Date.now() };

  await env.APP_KV.put(
    key,
    JSON.stringify(current),
    { expirationTtl: EDITOR_PRESENCE_TTL_SECONDS },
  );

  const activeEditors = [];
  const now = Date.now();
  for (const [username, meta] of Object.entries(current.users)) {
    if (!username || username === session.username) continue;
    if (!meta || !isFiniteNumber(meta.updatedAt)) continue;
    if ((now - meta.updatedAt) > EDITOR_PRESENCE_TTL_SECONDS * 1000) continue;
    activeEditors.push(username);
  }

  const graphVersion = await readGraphVersion(env, campaignId);

  return json({
    ok: true,
    campaignId,
    username: session.username,
    activeEditors: [...new Set(activeEditors)],
    graphUpdatedAt: graphVersion.updatedAt,
    graphUpdatedBy: graphVersion.updatedBy,
    graphCommit: graphVersion.commit,
  });
}

async function handleGithubWebhook(request, env) {
  if (!isGithubWebhookEnabled(env)) {
    return err('GitHub webhooks are disabled', 403);
  }

  const webhookSecret = String(env.GITHUB_WEBHOOK_SECRET ?? '').trim();
  if (!webhookSecret) {
    return err('Server misconfigured: missing GITHUB_WEBHOOK_SECRET', 500);
  }

  const signatureHeader = request.headers.get('X-Hub-Signature-256');
  const eventName = request.headers.get('X-GitHub-Event') || 'unknown';
  const deliveryId = request.headers.get('X-GitHub-Delivery') || null;

  if (!deliveryId) {
    return err('Missing X-GitHub-Delivery header', 400);
  }

  const deliveryKey = getWebhookDeliveryKey(deliveryId);
  const alreadyProcessed = await env.APP_KV.get(deliveryKey);
  if (alreadyProcessed) {
    return json({
      ok: true,
      event: eventName,
      deliveryId,
      processed: false,
      duplicate: true,
      reason: 'duplicate delivery id',
    });
  }

  const payloadText = await request.text();

  const isValidSignature = await verifyGithubWebhookSignature(
    payloadText,
    signatureHeader,
    webhookSecret,
  );

  if (!isValidSignature) {
    return err('Invalid webhook signature', 401);
  }

  let payload;
  try {
    payload = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    return err('Invalid webhook JSON payload', 400);
  }

  if (eventName === 'ping') {
    await env.APP_KV.put(deliveryKey, '1', { expirationTtl: WEBHOOK_DELIVERY_TTL_SECONDS });
    return json({ ok: true, event: eventName, deliveryId, processed: false, reason: 'ping' });
  }

  if (eventName === 'push') {
    const expectedBranch = env.GITHUB_BRANCH || null;
    const pushedRef = typeof payload?.ref === 'string' ? payload.ref : null;
    const expectedRef = expectedBranch ? `refs/heads/${expectedBranch}` : null;

    if (expectedRef && pushedRef && pushedRef !== expectedRef) {
      await env.APP_KV.put(deliveryKey, '1', { expirationTtl: WEBHOOK_DELIVERY_TTL_SECONDS });
      return json({
        ok: true,
        event: eventName,
        deliveryId,
        processed: false,
        reason: `ignored ref ${pushedRef}`,
      });
    }

    await env.APP_KV.put(deliveryKey, '1', { expirationTtl: WEBHOOK_DELIVERY_TTL_SECONDS });

    return json({
      ok: true,
      event: eventName,
      deliveryId,
      processed: true,
      ref: pushedRef,
      headCommit: payload?.after || null,
    });
  }

  await env.APP_KV.put(deliveryKey, '1', { expirationTtl: WEBHOOK_DELIVERY_TTL_SECONDS });

  return json({ ok: true, event: eventName, deliveryId, processed: false, reason: 'event not handled' });
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

    if (request.method === 'POST' && url.pathname === '/webhooks/github') {
      return handleGithubWebhook(request, env);
    }

    if (request.method === "GET" && url.pathname === "/projects") {
      return handleProjects(request, env);
    }

    const projectFileMatch = url.pathname.match(/^\/projects\/([^/]+)\/auth\/([^/]+)\/(.+)$/);
    if (request.method === "GET" && projectFileMatch) {
      const campaignId = decodeURIComponent(projectFileMatch[1]);
      const authToken = decodeURIComponent(projectFileMatch[2]);
      const fileSegments = projectFileMatch[3].split("/").map((segment) => decodeURIComponent(segment));
      return handleProjectFile(request, env, campaignId, authToken, fileSegments);
    }

    if (request.method === "POST" && url.pathname === "/save") {
      return handleSave(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/canvas-state') {
      return handleGetCanvasState(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/canvas-state') {
      return handleSaveCanvasState(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/presence') {
      return handleGetEditorPresence(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/presence') {
      return handleSaveEditorPresence(request, env);
    }

    return err("Not found", 404);
  },
};