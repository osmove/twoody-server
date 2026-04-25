import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT || "4320";
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const PAIRING_CODE = process.env.TWOODY_PAIRING_CODE || "654321";
const dataDir = mkdtempSync(join(tmpdir(), "twoody-server-smoke-"));

const child = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOST,
    PORT,
    TWOODY_PAIRING_CODE: PAIRING_CODE,
    TWOODY_DATA_DIR: dataDir,
    LOG_LEVEL: process.env.LOG_LEVEL || "error",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let logs = "";

child.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});

child.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

try {
  await waitForHealth();

  const pairing = await jsonFetch("/session/cli", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ code: PAIRING_CODE }),
  });

  const token = pairing.token;
  if (!token) {
    throw new Error("Smoke test failed: missing auth token from /session/cli");
  }

  const me = await jsonFetch("/session/me", {
    headers: authHeaders(token),
  });
  if (!me.id) {
    throw new Error("Smoke test failed: /session/me did not return a user");
  }

  const createdMember = await jsonFetch("/members", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 201,
    body: JSON.stringify({
      member: {
        name: "Smoke Test User",
        relationship: "tester",
        email: "smoke@example.com",
        enrollment_state: { wake_words: "pending" },
      },
    }),
  });

  if (!createdMember.member?.id) {
    throw new Error("Smoke test failed: member creation did not return a member");
  }

  const memberId = createdMember.member.id;

  const members = await jsonFetch("/members", {
    headers: authHeaders(token),
  });
  if (!Array.isArray(members.members) || members.members.length !== 1) {
    throw new Error("Smoke test failed: /members list is unexpected");
  }

  const toolCall = await jsonFetch("/tool_calls", {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      name: "list_household_members",
    }),
  });

  if (toolCall.status !== "ok" || !Array.isArray(toolCall.result)) {
    throw new Error("Smoke test failed: /tool_calls did not return the expected payload");
  }

  const bridgeOffline = await jsonFetch("/bridge/folders.json", {
    headers: authHeaders(token),
    expectedStatus: 503,
  });

  if (bridgeOffline.error !== "bridge_offline") {
    throw new Error("Smoke test failed: bridge offline error contract changed");
  }

  await jsonFetch(`/members/${memberId}`, {
    method: "DELETE",
    headers: authHeaders(token),
    expectedStatus: 204,
  });

  await jsonFetch("/session", {
    method: "DELETE",
    headers: authHeaders(token),
  });

  console.log("Twoody server smoke test passed");
} finally {
  child.kill("SIGTERM");
  await sleep(250);
  rmSync(dataDir, { recursive: true, force: true });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) {
        const payload = await response.json();
        if (payload.status === "ok") return;
      }
    } catch (_error) {
      // Boot still in progress.
    }
    await sleep(200);
  }

  throw new Error(`Smoke test failed: /health never became ready\n${logs}`);
}

async function jsonFetch(path, options = {}) {
  const { expectedStatus = 200, ...fetchOptions } = options;
  const response = await fetch(`${BASE_URL}${path}`, fetchOptions);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (response.status !== expectedStatus) {
    throw new Error(
      `Smoke test failed: ${fetchOptions.method || "GET"} ${path} -> expected ${expectedStatus}, got ${response.status}\n${text}\n${logs}`
    );
  }

  return payload;
}

function jsonHeaders() {
  return {
    "content-type": "application/json",
  };
}

function authHeaders(token) {
  return {
    ...jsonHeaders(),
    authorization: `Bearer ${token}`,
  };
}
