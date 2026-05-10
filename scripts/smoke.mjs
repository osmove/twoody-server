import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT || "4320";
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const API_BASE_URL = `${BASE_URL}/api/v1`;
const PAIRING_CODE = process.env.TWOODY_PAIRING_CODE || "A7B9C2D4";
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

  const capabilities = await jsonFetch("/capabilities");
  if (capabilities.deployment_kind !== "local") {
    throw new Error("Smoke test failed: /capabilities did not report deployment_kind=local");
  }
  if (capabilities.has_billing !== false || capabilities.providers_writable !== true) {
    throw new Error("Smoke test failed: /capabilities flags do not match the local profile");
  }
  if (capabilities.has_emails !== false) {
    throw new Error("Smoke test failed: /capabilities should report has_emails=false (no Postmark on twoody-server)");
  }

  const deployment = await jsonFetch("/deployment");
  if (deployment.kind !== "local" || !deployment.version || !deployment.instance_name) {
    throw new Error("Smoke test failed: /deployment payload missing kind/version/instance_name");
  }

  const setupToken = readFileSync(join(dataDir, "setup-token"), "utf8").trim();

  const signup = await jsonFetch("/auth/signup", {
    method: "POST",
    headers: jsonHeaders(),
    expectedStatus: 201,
    body: JSON.stringify({
      email: "smoke@example.com",
      password: "correct horse battery staple",
      name: "Smoke Test",
      setup_token: setupToken,
    }),
  });

  const token = signup.token;
  if (!token) {
    throw new Error("Smoke test failed: missing auth token from /auth/signup");
  }

  const signedIn = await jsonFetch("/auth/signin", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      email: "smoke@example.com",
      password: "correct horse battery staple",
      client_kind: "cli",
    }),
  });
  if (!signedIn.token) {
    throw new Error("Smoke test failed: missing auth token from /auth/signin");
  }

  const pairing = await jsonFetch("/session/cli", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ code: PAIRING_CODE.toLowerCase() }),
  });
  if (!pairing.token) {
    throw new Error("Smoke test failed: missing auth token from /session/cli");
  }

  const me = await jsonFetch("/auth/me", {
    headers: xUserTokenHeaders(token),
  });
  if (!me.id) {
    throw new Error("Smoke test failed: /auth/me did not return a user");
  }

  const noProviderQuery = await jsonFetch("/queries", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 503,
    body: JSON.stringify({ content: "hello" }),
  });
  if (noProviderQuery.error !== "local_llm_unavailable") {
    throw new Error("Smoke test failed: /queries did not enforce local-first fallback");
  }

  const provider = await jsonFetch("/providers/local", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 201,
    body: JSON.stringify({
      url: "http://127.0.0.1:9/v1",
      model: "tiny-local-model",
    }),
  });
  if (!provider.provider?.id || provider.provider.is_default !== true) {
    throw new Error("Smoke test failed: local provider was not created as default");
  }

  await jsonFetch("/providers/local", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 409,
    body: JSON.stringify({
      url: "http://127.0.0.1:9/v1/",
      model: "tiny-local-model",
    }),
  });

  await jsonFetch("/providers/local", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 422,
    body: JSON.stringify({
      url: "file:///tmp/not-a-provider",
      model: "tiny-local-model",
    }),
  });

  const patchedProvider = await jsonFetch(`/providers/${provider.provider.id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({
      name: "Smoke Local LLM",
      url: "http://127.0.0.1:9/v1/",
      model: "tiny-local-model",
    }),
  });
  if (patchedProvider.provider?.base_url !== "http://127.0.0.1:9/v1") {
    throw new Error("Smoke test failed: provider patch did not normalize base_url");
  }

  const providers = await jsonFetch("/providers", {
    headers: authHeaders(token),
  });
  if (!Array.isArray(providers.providers) || providers.providers.length !== 1) {
    throw new Error("Smoke test failed: /providers list is unexpected");
  }

  const localDownQuery = await jsonFetch("/queries", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 503,
    body: JSON.stringify({ content: "hello" }),
  });
  if (localDownQuery.error !== "local_llm_unavailable") {
    throw new Error("Smoke test failed: local provider down should return local_llm_unavailable");
  }

  await jsonFetch("/devices/llm_keys", {
    expectedStatus: 401,
  });

  const pairedDevice = await jsonFetch("/devices/pair", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ code: PAIRING_CODE, device_name: "smoke-pi" }),
  });
  if (!pairedDevice.device_id || !pairedDevice.user_token) {
    throw new Error("Smoke test failed: device pairing did not return device credentials");
  }

  await jsonFetch(`/devices/${pairedDevice.device_id}/update_check`, {
    expectedStatus: 401,
  });

  const updateCheck = await jsonFetch(`/devices/${pairedDevice.device_id}/update_check`, {
    headers: authHeaders(pairedDevice.user_token),
  });
  if (updateCheck.server_version === undefined) {
    throw new Error("Smoke test failed: authenticated update_check missing server_version");
  }

  await jsonFetch("/devices/llm_keys", {
    headers: authHeaders(pairedDevice.user_token),
  });

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

  const reminder = await jsonFetch("/reminders", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 201,
    body: JSON.stringify({
      reminder: {
        text: "Smoke reminder",
        notify_at: "2026-05-12T09:00:00.000Z",
      },
    }),
  });
  if (!reminder.id || reminder.status !== "active") {
    throw new Error("Smoke test failed: reminder creation did not return an active reminder");
  }

  const activeReminders = await jsonFetch("/reminders", {
    headers: authHeaders(token),
  });
  if (!Array.isArray(activeReminders) || activeReminders.length !== 1) {
    throw new Error("Smoke test failed: /reminders list is unexpected");
  }

  const doneReminder = await jsonFetch(`/reminders/${reminder.id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ reminder: { status: "done" } }),
  });
  if (doneReminder.status !== "done") {
    throw new Error("Smoke test failed: reminder patch did not mark done");
  }

  await jsonFetch(`/reminders/${reminder.id}`, {
    method: "DELETE",
    headers: authHeaders(token),
    expectedStatus: 204,
  });

  const deletedReminders = await jsonFetch("/reminders?filter=deleted", {
    headers: authHeaders(token),
  });
  if (!Array.isArray(deletedReminders) || deletedReminders.length !== 1) {
    throw new Error("Smoke test failed: deleted reminder filter is unexpected");
  }

  const contact = await jsonFetch("/contacts", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 201,
    body: JSON.stringify({
      contact: {
        name: "Sarah Smoke",
        email: "sarah@example.com",
        phone_number: "+33123456789",
      },
    }),
  });
  if (!contact.id || contact.email !== "sarah@example.com") {
    throw new Error("Smoke test failed: contact creation did not return the expected contact");
  }

  const contactSearch = await jsonFetch("/contacts/search?q=Sarah&only_with_email=1", {
    headers: authHeaders(token),
  });
  if (!Array.isArray(contactSearch.results) || contactSearch.results.length !== 1) {
    throw new Error("Smoke test failed: contact search is unexpected");
  }

  const shownContact = await jsonFetch(`/contacts/${contact.id}`, {
    headers: authHeaders(token),
  });
  if (shownContact.name !== "Sarah Smoke") {
    throw new Error("Smoke test failed: contact show did not return the created contact");
  }

  const event = await jsonFetch("/events", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 201,
    body: JSON.stringify({
      event: {
        name: "Smoke calendar event",
        start_time: "2026-05-12T09:00:00.000Z",
        end_time: "2026-05-12T09:30:00.000Z",
      },
    }),
  });
  if (!event.id || event.name !== "Smoke calendar event") {
    throw new Error("Smoke test failed: event creation did not return the expected event");
  }

  const agenda = await jsonFetch("/events?start_time=2026-05-12&end_time=2026-05-13", {
    headers: authHeaders(token),
  });
  if (!Array.isArray(agenda.events) || agenda.events.length !== 1 || agenda.events[0].local_id !== event.id) {
    throw new Error("Smoke test failed: event agenda list is unexpected");
  }

  const shownEvent = await jsonFetch(`/events/twoody:${event.id}`, {
    headers: authHeaders(token),
  });
  if (shownEvent.name !== "Smoke calendar event") {
    throw new Error("Smoke test failed: event show did not normalize twoody: IDs");
  }

  await jsonFetch(`/events/${event.id}`, {
    method: "DELETE",
    headers: authHeaders(token),
    expectedStatus: 204,
  });

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
  const response = await fetch(`${API_BASE_URL}${path}`, fetchOptions);
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

function xUserTokenHeaders(token) {
  return {
    ...jsonHeaders(),
    "x-user-token": token,
  };
}
