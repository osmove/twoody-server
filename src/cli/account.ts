import { createInterface } from "node:readline/promises";

// `twoody-server login | approve | logout` (bin/twoody-server.mjs).
//
// When the server runs on this machine, the commands ask it
// (/account/link, /account/approvals on loopback): it does the polling and
// starts its loops as soon as it is linked. When it does not run, they do
// the same work themselves against the data directory, and the server
// picks up account.json at its next start.

const PORT = Number(process.env.PORT ?? 3000);

function headers(): Record<string, string> {
  const token = process.env.TWOODY_ADMIN_TOKEN?.trim();
  return { Accept: "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

type LinkBody = { state: string; user_code?: string; verification_uri?: string; verification_uri_complete?: string | null; expires_at?: string; account_computer_id?: string; last_error?: string | null; fp?: string };

async function local(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any } | null> {
  try {
    // The server on this machine, on loopback: not the outbound gate's
    // business (nothing leaves the machine).
    const response = await globalThis.fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: init.method ?? "GET",
      headers: headers(),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function showCode(link: LinkBody): void {
  const where = link.verification_uri_complete ?? link.verification_uri ?? "https://twoody.com/appareil";
  console.log(`\n  To add this server to your Twoody account, open\n\n    ${where}\n\n  on a device signed in to it (or Twoody Desktop, or the Twoody app), and enter the code\n\n    ${link.user_code}\n`);
  if (link.fp) console.log(`  This server's fingerprint: ${link.fp}\n`);
  console.log("  Waiting for the approval… (Ctrl-C to stop)");
}

function explain(link: LinkBody): string {
  if (link.last_error === "denied") return "The request was refused.";
  if (link.last_error === "expired") return "The code expired. Run twoody-server login again.";
  return "Not linked.";
}

async function login(): Promise<number> {
  const current = await local("/account/link");
  if (current && current.status === 200) {
    let link = current.body as LinkBody;
    if (link.state === "linked") {
      console.log(`Already linked to a Twoody account (computer ${link.account_computer_id}).`);
      return 0;
    }
    if (link.state !== "pending" || !link.user_code) {
      const started = await local("/account/link", { method: "POST", body: {} });
      if (!started || started.status >= 300) {
        console.error(`Could not start linking: ${started?.body?.message ?? started?.body?.error ?? "no answer from the server"}`);
        return 1;
      }
      link = started.body as LinkBody;
    }
    showCode(link);
    for (;;) {
      await sleep(2_000);
      const next = await local("/account/link");
      if (!next) continue;
      link = next.body as LinkBody;
      if (link.state === "linked") {
        console.log(`\nLinked. This server is now computer ${link.account_computer_id} of your account.`);
        return 0;
      }
      if (link.state === "unlinked") {
        console.error(`\n${explain(link)}`);
        return 1;
      }
    }
  }
  if (current && current.status === 403) {
    console.error("The server on this machine refused: set TWOODY_ADMIN_TOKEN to its admin token.");
    return 1;
  }

  // No server running: the flow here, account.json written for its next start.
  const { startLink, linkState, linkView } = await import("../account/link.js");
  const { linkedAccount, fingerprint, ensureAccountFile } = await import("../account/store.js");
  if (linkedAccount()) {
    console.log(`Already linked to a Twoody account (computer ${linkedAccount()!.computer.id}).`);
    return 0;
  }
  try {
    showCode({ ...(await startLink()), fp: fingerprint(ensureAccountFile()) ?? undefined } as LinkBody);
  } catch (err) {
    console.error(`Could not start linking: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (;;) {
    await sleep(1_000);
    const state = linkState();
    if (state === "linked") {
      console.log(`\nLinked. This server is computer ${linkedAccount()!.computer.id} of your account; start it (or restart it) to use it.`);
      return 0;
    }
    if (state === "unlinked") {
      console.error(`\n${explain(linkView() as LinkBody)}`);
      return 1;
    }
  }
}

type Waiting = { id: string; name: string; role: string; expires_at: string; verdict?: { approve: boolean; reason?: string } };

async function choose(requests: Waiting[], wanted: string | null): Promise<Waiting | null> {
  if (wanted) return requests.find((r) => r.id === wanted) ?? null;
  requests.forEach((r, i) => console.log(`  ${i + 1}. ${r.name}${r.role === "peer" ? " (a computer of the account)" : ""} — until ${new Date(r.expires_at).toLocaleTimeString()}`));
  if (!process.stdin.isTTY) {
    console.log("\nRun twoody-server approve <id> to allow one:");
    requests.forEach((r) => console.log(`  ${r.id}  ${r.name}`));
    return null;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("\nNumber to allow (Enter to cancel): ")).trim();
  rl.close();
  const index = Number(answer);
  return Number.isInteger(index) && index >= 1 && index <= requests.length ? requests[index - 1]! : null;
}

async function approve(args: string[]): Promise<number> {
  const deny = args.includes("--deny");
  const wanted = args.find((a) => !a.startsWith("-")) ?? null;
  const listed = await local("/account/approvals");
  if (listed && listed.status === 200) {
    const requests = ((listed.body?.requests ?? []) as Waiting[]).filter((r) => Date.parse(r.expires_at) > Date.now());
    if (requests.length === 0) {
      console.log("No request is waiting.");
      return 0;
    }
    const request = await choose(requests, wanted);
    if (!request) return wanted ? (console.error(`No waiting request ${wanted}.`), 1) : 0;
    const done = await local(`/account/approvals/${encodeURIComponent(request.id)}`, { method: "POST", body: { decision: deny ? "deny" : "approve" } });
    if (!done || done.status !== 204) {
      console.error(`Failed: ${done?.body?.message ?? done?.body?.error ?? "no answer"}`);
      return 1;
    }
    console.log(deny ? `Refused "${request.name}".` : `Allowed "${request.name}".`);
    return 0;
  }
  if (listed && listed.status === 409) {
    console.error("This server is not linked to a Twoody account: twoody-server login");
    return 1;
  }
  if (listed && listed.status !== 200) {
    console.error(`The server refused: ${listed.body?.message ?? listed.body?.error ?? listed.status}`);
    return 1;
  }

  const { linkedAccount } = await import("../account/store.js");
  const { fetchPending, approveRequest, denyRequest } = await import("../account/approvals.js");
  const account = linkedAccount();
  if (!account) {
    console.error("This server is not linked to a Twoody account: twoody-server login");
    return 1;
  }
  const requests = (await fetchPending(account)).filter((r) => Date.parse(r.expires_at) > Date.now());
  if (requests.length === 0) {
    console.log("No request is waiting.");
    return 0;
  }
  const request = await choose(requests, wanted);
  if (!request) return wanted ? (console.error(`No waiting request ${wanted}.`), 1) : 0;
  const full = requests.find((r) => r.id === request.id)!;
  if (deny) await denyRequest(account, full);
  else await approveRequest(account, full);
  console.log(deny ? `Refused "${full.name}".` : `Allowed "${full.name}".`);
  return 0;
}

async function logout(): Promise<number> {
  const done = await local("/account/link", { method: "DELETE" });
  if (done && done.status === 200) {
    console.log("This server left the Twoody account.");
    return 0;
  }
  if (done && done.status !== 200) {
    console.error(`The server refused: ${done.body?.message ?? done.body?.error ?? done.status}`);
    return 1;
  }
  const { logout: leave } = await import("../account/link.js");
  await leave();
  console.log("This server left the Twoody account.");
  return 0;
}

export async function runAccountCommand(command: string, args: string[]): Promise<number> {
  switch (command) {
    case "login":
      return login();
    case "approve":
      return approve(args);
    case "logout":
      return logout();
    default:
      console.error(`unknown command: ${command}`);
      return 2;
  }
}
