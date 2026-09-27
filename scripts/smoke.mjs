import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.PORT || "4320";
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const API_BASE_URL = `${BASE_URL}/api/v1`;
const PAIRING_CODE = process.env.TWOODY_PAIRING_CODE || "A7B9C2D4";
const dataDir = mkdtempSync(join(tmpdir(), "twoody-server-smoke-"));

const child = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: process.cwd(),
  detached: true,
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

  // Chat context: point the provider at a fake OpenAI-compatible
  // server and check what a second turn actually puts on the wire.
  const fakeLlm = await startFakeLlm();
  try {
    await jsonFetch(`/providers/${provider.provider.id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify({ url: `${fakeLlm.url}/v1`, model: "tiny-local-model" }),
    });
    await jsonFetch("/memories", {
      method: "POST",
      headers: authHeaders(token),
      expectedStatus: 201,
      body: JSON.stringify({ memory: { kind: "user", title: "Job", content: "Patent attorney in Lyon." } }),
    });

    // « Réfléchi » asked for: in « Rapide » the server cuts at once a
    // model that reasons anyway, and this fake one always does — how fast
    // its chunks arrive would then decide the test (it did, on CI).
    const firstTurn = await sseQuery(token, { content: "My client is called Dupont.", effort: "think" });
    if (firstTurn.final?.text !== "Hello from the fake model") {
      throw new Error(`Smoke test failed: reasoning block leaked into the reply: ${JSON.stringify(firstTurn.final)}`);
    }
    if (fakeLlm.requests.length !== 2 || !fakeLlm.requests[0].chat_template_kwargs || fakeLlm.requests[1].chat_template_kwargs) {
      throw new Error("Smoke test failed: /queries did not retry without chat_template_kwargs after a 400");
    }

    await sseQuery(token, { content: "What is my client's name?", discussion_id: firstTurn.final.discussion_id, effort: "think" });
    const sent = fakeLlm.requests[fakeLlm.requests.length - 1].messages;
    const roles = sent.map((message) => message.role).join(",");
    if (roles !== "system,user,assistant,user") {
      throw new Error(`Smoke test failed: unexpected chat roles on the wire: ${roles}`);
    }
    if (!sent[0].content.includes("Patent attorney in Lyon.")) {
      throw new Error("Smoke test failed: profile memory missing from the system prompt");
    }
    if (!sent[1].content.includes("Dupont") || sent[2].content !== "Hello from the fake model") {
      throw new Error("Smoke test failed: previous turn missing from the chat history");
    }
    if (sent[3].content !== "What is my client's name?") {
      throw new Error(`Smoke test failed: current prompt is not the last message: ${JSON.stringify(sent[3].content).slice(0, 600)}\n${logs.slice(-3000)}`);
    }

    // "New conversation": on a text surface, a message that names no
    // conversation starts one, and must not inherit the previous exchange.
    const threadsBefore = (await jsonFetch("/discussions", { headers: authHeaders(token) })).discussions.length;
    const fresh = await sseQuery(token, { content: "Unrelated question.", channel: "desktop" });
    if (!fresh.final?.discussion_id || fresh.final.discussion_id === firstTurn.final.discussion_id) {
      throw new Error("Smoke test failed: a message without discussion_id was attached to the previous conversation");
    }
    const freshRoles = fakeLlm.requests[fakeLlm.requests.length - 1].messages.map((message) => message.role).join(",");
    if (freshRoles !== "system,user") {
      throw new Error(`Smoke test failed: a new conversation inherited an earlier exchange: ${freshRoles}`);
    }
    // A voice surface has no such button: two utterances a moment apart
    // belong together, unless the client asks to start over.
    const spoken = await sseQuery(token, { content: "What time is it?", channel: "device" });
    const spokenAgain = await sseQuery(token, { content: "And tomorrow?", channel: "device" });
    if (spokenAgain.final.discussion_id !== spoken.final.discussion_id) {
      throw new Error("Smoke test failed: two utterances a moment apart landed in two conversations");
    }
    const startOver = await sseQuery(token, { content: "Start over.", channel: "device", force_new_discussion: true });
    if (startOver.final.discussion_id === spoken.final.discussion_id) {
      throw new Error("Smoke test failed: force_new_discussion did not start a new conversation");
    }
    // The new conversation (which the two utterances then continued) and
    // the one started over: two more than before.
    const threadsAfter = (await jsonFetch("/discussions", { headers: authHeaders(token) })).discussions.length;
    if (threadsAfter !== threadsBefore + 2) {
      throw new Error(`Smoke test failed: expected ${threadsBefore + 2} conversations, got ${threadsAfter}`);
    }

    // Stop: the reader leaves mid-answer. The model must be stopped too,
    // and what was written kept in the conversation.
    const stopping = new AbortController();
    const stopped = await fetch(`${API_BASE_URL}/queries`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ content: "SLOW ANSWER please" }),
      signal: stopping.signal,
    });
    const stoppedReader = stopped.body.getReader();
    let seen = "";
    while (!seen.includes("word3")) {
      const { value, done } = await stoppedReader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    stopping.abort();
    await sleep(600);
    if (fakeLlm.abandoned.length !== 1 || fakeLlm.abandoned[0] > 20) {
      throw new Error(`Smoke test failed: the runtime kept generating after the client left (${JSON.stringify(fakeLlm.abandoned)})`);
    }
    // The stopped question named no conversation, so it started one: the
    // most recent of the list.
    const afterStop = await jsonFetch("/discussions", { headers: authHeaders(token) });
    const stoppedThread = await jsonFetch(`/discussions/${afterStop.discussions[0].id}`, { headers: authHeaders(token) });
    if (!stoppedThread.messages.some((message) => message.role === "user" && message.content === "SLOW ANSWER please")) {
      throw new Error("Smoke test failed: the most recent conversation is not the one that was just stopped");
    }
    const kept = stoppedThread.messages.filter((message) => message.role === "assistant").at(-1);
    if (!kept || !/^word1 word2 .*…$/.test(kept.content)) {
      throw new Error(`Smoke test failed: the text written before a stop was not kept: ${JSON.stringify(kept)}`);
    }

    // Document Q&A: grant a folder holding a copy of the fixtures, wait
    // for the index, and check the excerpts reach the model with their
    // sources coming back to the client.
    // Not under the OS temp dir: on macOS that resolves to /private/var,
    // which the server rightly refuses to index.
    const library = mkdtempSync(join(process.cwd(), "smoke-docs-CV-"));
    try {
      for (const name of ["contrat-dupont.pdf", "contrat-dupont.docx"]) {
        cpSync(join(process.cwd(), "test", "fixtures", name), join(library, name));
      }
      writeFileSync(join(library, "CV_Jimmy.txt"), "Parcours professionnel : responsable commercial depuis 2020.");
      writeFileSync(join(library, "lettre.txt"), "Lettre de motivation pour un nouvel emploi.");
      writeFileSync(join(library, "notes.txt"), "Mon CV contient toutes mes expériences.");
      await jsonFetch("/local_documents/folders", {
        method: "POST",
        headers: authHeaders(token),
        expectedStatus: 422,
        body: JSON.stringify({ path: "/etc" }),
      });
      await jsonFetch("/local_documents/folders", {
        method: "POST",
        headers: authHeaders(token),
        expectedStatus: 201,
        body: JSON.stringify({ path: library }),
      });

      let folders;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        folders = await jsonFetch("/local_documents/folders", { headers: authHeaders(token) });
        if (!folders.index.running && folders.folders[0]?.indexed === 5) break;
        await sleep(250);
      }
      if (folders.folders[0]?.indexed !== 5) {
        throw new Error(`Smoke test failed: documents were not indexed: ${JSON.stringify(folders)}`);
      }

      const found = await jsonFetch(`/local_documents/search?q=${encodeURIComponent("delai de preavis resiliation")}`, {
        headers: authHeaders(token),
      });
      if (!found.passages.some((passage) => passage.name === "contrat-dupont.pdf" && passage.page === 1)) {
        throw new Error(`Smoke test failed: search did not return the PDF passage: ${JSON.stringify(found)}`);
      }

      const shortSearch = await jsonFetch("/local_documents/search?q=cv", { headers: authHeaders(token) });
      if (!shortSearch.passages.some(p => p.name === "CV_Jimmy.txt" && p.match === "name") ||
          !shortSearch.passages.some(p => p.name === "notes.txt" && p.match === "content") ||
          !shortSearch.passages.some(p => p.name === "lettre.txt" && p.match === "name")) throw new Error("Smoke test failed: CV body/name/folder lookup");
      const files = await jsonFetch(`/local_documents/files?folder_id=${folders.folders[0].id}`, { headers: authHeaders(token) });
      if (files.total !== 5 || files.files.length !== 5 || !files.files.every(file => file.status === "indexed")) throw new Error("Smoke test failed: indexed file inventory");
      const unknownFiles = await jsonFetch("/local_documents/files?folder_id=not-granted", { headers: authHeaders(token) });
      if (unknownFiles.total !== 0 || unknownFiles.files.length) throw new Error("Smoke test failed: ungranted inventory");
      await jsonFetch("/local_documents/files?folder_id=x&offset=-1", { headers: authHeaders(token), expectedStatus: 400 });
      await jsonFetch(`/local_documents/files?folder_id=${folders.folders[0].id}`, { expectedStatus: 401 });
      const filePage = await jsonFetch(`/local_documents/files?folder_id=${folders.folders[0].id}&offset=4`, { headers: authHeaders(token) });
      if (filePage.files.length !== 1 || filePage.total !== 5 || filePage.offset !== 4) throw new Error("Smoke test failed: file pagination");
      await sseQuery(token, { content: "À quels dossiers as-tu accès ?" });
      if (!fakeLlm.requests.at(-1).messages.at(-1).content.includes("smoke-docs-CV-")) throw new Error("Smoke test failed: granted folder list missing from model context");

      for (const access of [{mode:"off"}, {mode:"selected",folderIds:[]}, {mode:"selected",folderIds:["not-granted"]}]) {
        const turn = await sseQuery(token, {content:"Résume CV_Jimmy.txt", document_access:access});
        const prompt = fakeLlm.requests.at(-1).messages.at(-1).content;
        if (turn.final.sources?.length || prompt.includes("Parcours professionnel") || prompt.includes("[Local document library")) throw new Error("Smoke test failed: document access scope leaked");
      }
      const cvTurn = await sseQuery(token, {content:"Lis CV_Jimmy.txt", document_access:{mode:"selected",folderIds:[folders.folders[0].id]}});
      if (!cvTurn.final.sources?.some(s=>s.name==="CV_Jimmy.txt")) throw new Error("Smoke test failed: selected file read");
      await sseQuery(token, {content:"Tu peux me le résumer ?",discussion_id:cvTurn.final.discussion_id});
      const follow = fakeLlm.requests.at(-1).messages.at(-1).content;
      if (!follow.includes("Parcours professionnel") || !follow.includes("modified_at")) throw new Error("Smoke test failed: referenced file or dates lost");
      await sseQuery(token, {content:"Lequel est le plus récent parmi mes CVs ?"});
      if (!fakeLlm.requests.at(-1).messages.at(-1).content.includes("CV_Jimmy.txt")) throw new Error("Smoke test failed: plural CV metadata retrieval");
      await sseQuery(token, {content:"Résume CV_Jimmy.txt",document_access:{mode:"only"}});
      if (!fakeLlm.requests.at(-1).messages.at(-1).content.includes("[Document-only mode]")) throw new Error("Smoke test failed: document-only policy missing");

      const documentTurn = await sseQuery(token, { content: "Quel est le préavis de résiliation du contrat ?" });
      const lastMessage = fakeLlm.requests[fakeLlm.requests.length - 1].messages.at(-1).content;
      if (!lastMessage.includes("[Excerpts from the user's documents]") || !lastMessage.includes("préavis de six mois")) {
        throw new Error("Smoke test failed: document excerpts did not reach the model");
      }
      if (!documentTurn.final.sources?.some((source) => source.n === 1 && source.path.startsWith(library))) {
        throw new Error(`Smoke test failed: sources missing from the final event: ${JSON.stringify(documentTurn.final.sources)}`);
      }

      const reopened = await jsonFetch(`/discussions/${documentTurn.final.discussion_id}`, { headers: authHeaders(token) });
      if (!reopened.messages.at(-1).sources?.length) {
        throw new Error("Smoke test failed: sources were not kept with the assistant message");
      }

      const known = await jsonFetch(`/local_documents/known?path=${encodeURIComponent("/etc/passwd")}`, { headers: authHeaders(token) });
      if (known.known !== false) throw new Error("Smoke test failed: an arbitrary path was reported as indexed");

      // The answer was thrown away here, so a revoke that failed looked
      // exactly like an index that would not clear.
      const revoked = await fetch(`${API_BASE_URL}/local_documents/folders/${folders.folders[0].id}`, { method: "DELETE", headers: authHeaders(token) });
      if (revoked.status !== 204) {
        throw new Error(`Smoke test failed: revoking a folder answered ${revoked.status}: ${await revoked.text()}`);
      }
      const afterRevoke = await jsonFetch(`/local_documents/search?q=preavis`, { headers: authHeaders(token) });
      if (afterRevoke.passages.length !== 0) throw new Error("Smoke test failed: revoking a folder left its passages searchable");
      const revokedNames = await jsonFetch("/local_documents/search?q=cv", { headers: authHeaders(token) });
      const revokedFiles = await jsonFetch(`/local_documents/files?folder_id=${folders.folders[0].id}`, { headers: authHeaders(token) });
      if (revokedNames.passages.length || revokedFiles.files.length) throw new Error("Smoke test failed: revoked metadata still accessible");
    } finally {
      rmSync(library, { recursive: true, force: true });
    }
  } finally {
    await fakeLlm.close();
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

  // Bridge worker routes: a token is required, a worker only ever sees
  // its own user's tasks, and task ids are not guessable.
  await jsonFetch("/bridge/tasks/next", { expectedStatus: 401 });
  await jsonFetch("/bridge/tasks/anything", {
    method: "PATCH",
    headers: jsonHeaders(),
    expectedStatus: 401,
    body: JSON.stringify({ status: "done", result: {} }),
  });

  const enqueued = await jsonFetch("/bridge/tasks", {
    method: "POST",
    headers: authHeaders(token),
    expectedStatus: 201,
    body: JSON.stringify({ kind: "search", args: { query: "contrat Dupont" } }),
  });
  if (!/^[0-9a-f]{32}$/.test(enqueued.id)) {
    throw new Error(`Smoke test failed: bridge task id is not a random 128-bit id: ${enqueued.id}`);
  }

  const claimed = await jsonFetch("/bridge/tasks/next", {
    headers: { ...authHeaders(token), "x-bridge-device-id": "smoke-worker" },
  });
  if (claimed.id !== enqueued.id || claimed.args?.query !== "contrat Dupont") {
    throw new Error("Smoke test failed: authenticated worker did not receive the queued task");
  }

  await fetch(`${API_BASE_URL}/bridge/tasks/${enqueued.id}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ status: "done", result: { hits: [] } }),
  }).then((response) => {
    if (response.status !== 204) {
      throw new Error(`Smoke test failed: worker report -> expected 204, got ${response.status}`);
    }
  });
  const finished = await jsonFetch(`/bridge/tasks/${enqueued.id}`, { headers: authHeaders(token) });
  if (finished.status !== "done") {
    throw new Error("Smoke test failed: bridge task result was not recorded");
  }

  // The standalone worker (what the desktop app runs for a cloud
  // account): pointed at this server as its backend and at a fake
  // runtime, it must pick up an llm_infer task, stream it, and report
  // the completion in the envelope the Rails backend reads.
  await smokeBridgeWorker(token);

  // The MCP proxy acts with the user's token upstream: never open.
  const mcpAnonymous = await fetch(`${BASE_URL}/mcp`, { method: "POST", headers: jsonHeaders(), body: "{}" });
  if (mcpAnonymous.status !== 401) {
    throw new Error(`Smoke test failed: anonymous /mcp -> expected 401, got ${mcpAnonymous.status}`);
  }

  // The admin page answers this machine, and refuses a cross-site read
  // (CORS reflects any origin, so the browser would otherwise allow it).
  const adminLocal = await fetch(`${BASE_URL}/admin`);
  if (adminLocal.status !== 200) {
    throw new Error(`Smoke test failed: /admin from loopback -> ${adminLocal.status}`);
  }
  const adminCrossSite = await fetch(`${BASE_URL}/admin`, { headers: { "sec-fetch-site": "cross-site" } });
  if (adminCrossSite.status !== 403) {
    throw new Error(`Smoke test failed: cross-site /admin -> ${adminCrossSite.status}`);
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

  await smokeLocalOnly();

  console.log("Twoody server smoke test passed");
} finally {
  stop(child);
  await sleep(250);
  rmSync(dataDir, { recursive: true, force: true });
}
// Nothing left to wait for: a handle a child left open must not keep the
// run going (CI sat eight minutes after "passed").
process.exit(0);

/// npx starts tsx, which starts node: on Linux, killing npx alone left the
/// server running with this script's pipes open, and the run waiting for
/// ever. Each child has its own process group, and the group goes.
function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  try {
    process.kill(-proc.pid, "SIGTERM");
  } catch {
    proc.kill("SIGTERM");
  }
}

// Second instance with TWOODY_LOCAL_ONLY=1 and everything that would
// normally open a cloud path switched on: the gate has to win.
async function smokeLocalOnly() {
  const port = String(Number(PORT) + 1);
  const base = `http://${HOST}:${port}/api/v1`;
  const dir = mkdtempSync(join(tmpdir(), "twoody-server-smoke-local-only-"));
  const server = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      HOST,
      PORT: port,
      TWOODY_DATA_DIR: dir,
      TWOODY_BONJOUR_DISABLED: "1",
      TWOODY_LOCAL_ONLY: "1",
      TWOODY_CLOUD_FALLBACK_ENABLED: "true",
      OPENAI_API_KEY: "sk-smoke-not-a-real-key",
      LOG_LEVEL: "error",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLogs = "";
  server.stdout.on("data", (chunk) => {
    serverLogs += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverLogs += chunk.toString();
  });

  const call = async (path, options = {}) => {
    const { expectedStatus = 200, ...fetchOptions } = options;
    const response = await fetch(`${base}${path}`, fetchOptions);
    const text = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `Smoke test failed (local-only): ${fetchOptions.method || "GET"} ${path} -> expected ${expectedStatus}, got ${response.status}\n${text}\n${serverLogs}`
      );
    }
    return text ? JSON.parse(text) : {};
  };

  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        if ((await fetch(`http://${HOST}:${port}/health`)).ok) break;
      } catch (_error) {
        // Boot still in progress.
      }
      await sleep(200);
    }

    const capabilities = await call("/capabilities");
    const deployment = await call("/deployment");
    if (capabilities.local_only !== true || deployment.local_only !== true) {
      throw new Error("Smoke test failed (local-only): local_only flag not reported");
    }

    const signup = await call("/auth/signup", {
      method: "POST",
      headers: jsonHeaders(),
      expectedStatus: 201,
      body: JSON.stringify({
        email: "local-only@example.com",
        password: "correct horse battery staple",
        setup_token: readFileSync(join(dir, "setup-token"), "utf8").trim(),
      }),
    });
    const headers = authHeaders(signup.token);

    // Cloud fallback is enabled and a key is present, yet no provider
    // means no answer rather than a call to OpenAI.
    const noFallback = await call("/queries", {
      method: "POST",
      headers,
      expectedStatus: 503,
      body: JSON.stringify({ content: "hello" }),
    });
    if (noFallback.error !== "local_llm_unavailable") {
      throw new Error("Smoke test failed (local-only): cloud fallback was not disabled");
    }

    const realtime = await call("/realtime_sessions", { method: "POST", headers, expectedStatus: 403, body: "{}" });
    if (realtime.error !== "local_only") {
      throw new Error("Smoke test failed (local-only): /realtime_sessions was not refused");
    }

    const keys = await call("/devices/llm_keys", { headers });
    if (keys.openai_api_key !== null) {
      throw new Error("Smoke test failed (local-only): /devices/llm_keys leaked a cloud key");
    }

    // A "local" provider that actually points at a public host.
    await call("/providers/local", {
      method: "POST",
      headers,
      expectedStatus: 201,
      body: JSON.stringify({ url: "https://8.8.8.8/v1", model: "not-local" }),
    });
    const publicProvider = await call("/queries", {
      method: "POST",
      headers,
      expectedStatus: 403,
      body: JSON.stringify({ content: "hello" }),
    });
    if (publicProvider.error !== "local_only") {
      throw new Error("Smoke test failed (local-only): public provider URL was not refused");
    }
  } finally {
    stop(server);
    await sleep(250);
    rmSync(dir, { recursive: true, force: true });
  }
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

// Minimal OpenAI-compatible streaming endpoint. It rejects
// `chat_template_kwargs` once, the way a strict server would, and opens
// its reply with a reasoning block the way Qwen3 does.
async function smokeBridgeWorker(token) {
  const runtime = await startFakeLlm();
  const home = mkdtempSync(join(tmpdir(), "twoody-worker-smoke-"));
  const worker = spawn("npx", ["tsx", "src/bridgeWorker.ts"], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      HOME: home, // keeps the worker's device id out of the real home
      TWOODY_BACKEND_URL: API_BASE_URL,
      TWOODY_USER_TOKEN: token,
      TWOODY_BRIDGE_DEVICE_NICKNAME: "Smoke\u2019s Mac",
      BRIDGE_LOCAL_LLM_ENDPOINTS: `http://${HOST}:9/v1,${runtime.url}/v1`, // the first one is down
      BRIDGE_LOCAL_LLM_MODEL: "tiny-local-model",
      // A runtime that asks for a key (the one the desktop app ships).
      TWOODY_RUNTIME_KEYS: JSON.stringify({ [`${runtime.url}/v1`]: "smoke-key" }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerLogs = "";
  worker.stdout.on("data", (chunk) => (workerLogs += chunk));
  worker.stderr.on("data", (chunk) => (workerLogs += chunk));

  try {
    const deadline = Date.now() + 20_000;
    let presence;
    do {
      await new Promise((resolve) => setTimeout(resolve, 300));
      presence = await jsonFetch("/bridge/presence", { headers: authHeaders(token) });
    } while (!presence.capabilities?.includes("local-llm-provider") && Date.now() < deadline);
    if (!presence.capabilities?.includes("local-llm-provider")) {
      throw new Error(`Smoke test failed: the standalone worker never registered.\n${workerLogs}`);
    }

    const task = await jsonFetch("/bridge/tasks", {
      method: "POST",
      headers: authHeaders(token),
      expectedStatus: 201,
      body: JSON.stringify({
        kind: "llm_infer",
        args: { openai_body_json: JSON.stringify({ model: "local", messages: [{ role: "user", content: "Hi" }], max_tokens: 64 }) },
      }),
    });

    let finished;
    do {
      await new Promise((resolve) => setTimeout(resolve, 200));
      finished = await jsonFetch(`/bridge/tasks/${task.id}`, { headers: authHeaders(token) });
    } while (finished.status !== "done" && finished.status !== "error" && Date.now() < deadline);

    if (finished.status !== "done") {
      throw new Error(`Smoke test failed: llm_infer through the worker ended as ${finished.status} (${finished.error_message}).\n${workerLogs}`);
    }
    const completion = JSON.parse(finished.result.response_json);
    const answer = completion.choices[0].message.content;
    if (answer !== "Hello from the fake model" || finished.delta !== answer) {
      throw new Error(`Smoke test failed: worker completion ${JSON.stringify(answer)} / streamed ${JSON.stringify(finished.delta)}`);
    }
    if (runtime.authorizations.length === 0 || runtime.authorizations.some((value) => value !== "Bearer smoke-key")) {
      throw new Error(`Smoke test failed: the worker did not present the runtime's key on every call (${JSON.stringify(runtime.authorizations)})`);
    }
    if (finished.result.model_used !== "tiny-local-model" || runtime.requests.at(-1).model !== "tiny-local-model") {
      throw new Error("Smoke test failed: the placeholder model was not replaced by the worker's default");
    }
  } finally {
    stop(worker);
    await runtime.close();
    rmSync(home, { recursive: true, force: true });
  }
}

async function startFakeLlm() {
  const requests = [];
  const abandoned = [];
  const authorizations = [];
  let rejectedOnce = false;
  const server = createServer((req, res) => {
    authorizations.push(req.headers.authorization ?? null);
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "tiny-local-model" }, { id: "text-embedding-tiny" }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (body.chat_template_kwargs && !rejectedOnce) {
        rejectedOnce = true;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown field chat_template_kwargs" }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (String(body.messages.at(-1)?.content).includes("SLOW ANSWER")) {
        // A long answer, one word every 100 ms, until the client leaves.
        let count = 0;
        const timer = setInterval(() => {
          count += 1;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `word${count} ` } }] })}\n\n`);
          if (count >= 200) {
            clearInterval(timer);
            res.end("data: [DONE]\n\n");
          }
        }, 100);
        res.on("close", () => {
          clearInterval(timer);
          if (count < 200) abandoned.push(count);
        });
        return;
      }
      for (const content of ["<think>", "reasoning…", "</think>\n\n", "Hello from ", "the fake model"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve) => server.listen(0, HOST, resolve));
  return {
    url: `http://${HOST}:${server.address().port}`,
    requests,
    abandoned,
    authorizations,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function sseQuery(token, body) {
  // A turn that never ends is a failure, not a CI job left running for
  // hours: two minutes, then the server's own logs say why.
  let response;
  let text;
  try {
    response = await fetch(`${API_BASE_URL}/queries`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    text = await response.text();
  } catch (err) {
    throw new Error(`Smoke test failed: POST /queries ${JSON.stringify(body).slice(0, 200)} did not finish (${err.message})\n${logs.slice(-4000)}`);
  }
  if (response.status !== 200) {
    throw new Error(`Smoke test failed: POST /queries -> expected 200, got ${response.status}\n${text}\n${logs}`);
  }
  const finalEvent = text.split("\n\n").find((block) => block.startsWith("event: final"));
  return {
    text,
    final: finalEvent ? JSON.parse(finalEvent.slice(finalEvent.indexOf("data: ") + 6)) : null,
  };
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
