import { execSync } from "child_process";
import { readFileSync } from "fs";

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON for ${label}`);
  }
}

function loadJsonConfig({ jsonEnvKey, fileEnvKey, label }) {
  const filePath = process.env[fileEnvKey];
  if (filePath) {
    const raw = readFileSync(filePath, "utf8");
    return parseJson(raw, `${label} file (${filePath})`);
  }

  const raw = process.env[jsonEnvKey];
  if (raw) {
    return parseJson(raw, `${label} env (${jsonEnvKey})`);
  }

  throw new Error(
    `${label} not provided. Set ${jsonEnvKey} or ${fileEnvKey}.`,
  );
}

const USERS = loadJsonConfig({
  jsonEnvKey: "SEED_USERS_JSON",
  fileEnvKey: "SEED_USERS_FILE",
  label: "USERS",
});

const ACL = loadJsonConfig({
  jsonEnvKey: "SEED_ACL_JSON",
  fileEnvKey: "SEED_ACL_FILE",
  label: "ACL",
});



async function hashPassword(password) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    keyMaterial, 256
  );
  const toHex = (buf) =>
    [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:100000:${toHex(salt)}:${toHex(bits)}`;
}

function wranglerPut(key, value) {
  execSync(
    `wrangler kv key put --remote --preview false --binding=APP_KV '${key}' '${JSON.stringify(value)}'`,
    { stdio: "inherit" }
  );
}

async function main() {
  if (typeof USERS !== "object" || USERS === null || Array.isArray(USERS)) {
    throw new Error("USERS must be a JSON object: { \"username\": \"password\" }");
  }

  if (typeof ACL !== "object" || ACL === null || Array.isArray(ACL)) {
    throw new Error("ACL must be a JSON object: { \"campaign\": { \"user\": [\"read\"] } }");
  }

  console.log("Hashing passwords...");
  const passwords = {};
  for (const [user, plain] of Object.entries(USERS)) {
    passwords[user] = await hashPassword(plain);
    console.log(`  ✓ ${user}`);
  }

  console.log("\nWriting passwords to KV...");
  wranglerPut("passwords", passwords);

  console.log("\nWriting ACL to KV...");
  wranglerPut("acl", ACL);

  console.log("\n✅ KV seeded.");
}

main().catch((e) => { console.error(e); process.exit(1); });