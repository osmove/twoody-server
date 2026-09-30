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

type LinkBody = { state: string; user_code?: string; approval_secret?: string; verification_uri?: string; verification_uri_complete?: string | null; expires_at?: string; account_computer_id?: string; account?: string; last_error?: string | null; fp?: string; security_code?: string | null };

/// "the Twoody account j***@gmail.com" — or "a Twoody account" when the server did not say which.
function which(account: string | null | undefined): string {
  return account ? `the Twoody account ${account}` : "a Twoody account";
}

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
  // The one-time secret the account never sees: typed on the Desktop or
  // the phone, it proves that device is the one approving (account/link.ts).
  if (link.approval_secret) console.log(`  On Twoody Desktop or the Twoody app, also enter this one-time secret (never asked for on the website):\n\n    ${link.approval_secret}\n`);
  // What the approving screen shows for this computer, to compare: its
  // security code (from its tunnel key), never the 8-hex Bonjour hint.
  if (link.security_code) console.log(`  Security code of this server (check that the approving screen shows the same):\n\n    ${link.security_code}\n`);
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
      console.log(`Already linked to ${which(link.account)} (computer ${link.account_computer_id}).`);
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
    showCode({ ...link, security_code: link.security_code ?? (current.body as LinkBody).security_code ?? null });
    for (;;) {
      await sleep(2_000);
      const next = await local("/account/link");
      if (!next) continue;
      link = next.body as LinkBody;
      if (link.state === "linked") {
        console.log(`\nLinked to ${which(link.account)}. This server is now computer ${link.account_computer_id} of that account.`);
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
  const { linkedAccount } = await import("../account/store.js");
  if (linkedAccount()) {
    console.log(`Already linked to ${which(linkView().account)} (computer ${linkedAccount()!.computer.id}).`);
    return 0;
  }
  try {
    const { thisSecurityCode } = await import("../tunnel/identity.js");
    showCode({ ...(await startLink()), security_code: thisSecurityCode() } as LinkBody);
  } catch (err) {
    console.error(`Could not start linking: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  for (;;) {
    await sleep(1_000);
    const state = linkState();
    if (state === "linked") {
      console.log(`\nLinked to ${which(linkView().account)}. This server is computer ${linkedAccount()!.computer.id} of that account; start it (or restart it) to use it.`);
      return 0;
    }
    if (state === "unlinked") {
      console.error(`\n${explain(linkView() as LinkBody)}`);
      return 1;
    }
  }
}

type Waiting = { id: string; name: string; role: string; expires_at: string; security_code?: string | null; verdict?: { approve: boolean; reason?: string } };

/// What the console says before anything is allowed: the name is only
/// the account's say; the security code, from the key the device asks
/// with, is what the person compares with that device's own screen.
export const APPROVE_WARNING =
  "  Only allow a device whose own screen shows the same security code.\n" +
  "  The name comes from the Twoody account and proves nothing; a request you did not start yourself, refuse it.";

export function describeRequest(r: Pick<Waiting, "name" | "role" | "expires_at" | "security_code">): string {
  const code = r.security_code ? `security code ${r.security_code}` : "no security code (not a key): do not allow";
  return `${r.name}${r.role === "peer" ? " (a computer of the account)" : ""} — ${code} — until ${new Date(r.expires_at).toLocaleTimeString()}`;
}

async function choose(requests: Waiting[], wanted: string | null): Promise<Waiting | null> {
  console.log(APPROVE_WARNING + "\n");
  if (wanted) {
    const found = requests.find((r) => r.id === wanted) ?? null;
    if (found) console.log(`  ${describeRequest(found)}\n`);
    return found;
  }
  requests.forEach((r, i) => console.log(`  ${i + 1}. ${describeRequest(r)}`));
  if (!process.stdin.isTTY) {
    console.log("\nRun twoody-server approve <id> to allow one:");
    requests.forEach((r) => console.log(`  ${r.id}  ${r.name}  ${r.security_code ?? "-"}`));
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
  const { fetchPending, approveRequest, denyRequest, requestSecurityCode } = await import("../account/approvals.js");
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
  const request = await choose(requests.map((r) => ({ ...r, security_code: requestSecurityCode(r) })), wanted);
  if (!request) return wanted ? (console.error(`No waiting request ${wanted}.`), 1) : 0;
  const full = requests.find((r) => r.id === request.id)!;
  if (deny) await denyRequest(account, full);
  else await approveRequest(account, full);
  console.log(deny ? `Refused "${full.name}".` : `Allowed "${full.name}".`);
  return 0;
}

async function logout(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const done = await local(`/account/link${force ? "?force=1" : ""}`, { method: "DELETE" });
  if (done && done.status === 200) {
    console.log(done.body?.confirmed === false ? "This server left the Twoody account here; the account did not confirm it, remove it there too." : "This server left the Twoody account.");
    return 0;
  }
  if (done && done.status === 502) {
    console.error(`${done.body?.message ?? "The account did not confirm."}\nTry again, or run twoody-server logout --force to leave here anyway.`);
    return 1;
  }
  if (done) {
    console.error(`The server refused: ${done.body?.message ?? done.body?.error ?? done.status}`);
    return 1;
  }
  const { logout: leave, LeaveUnconfirmedError } = await import("../account/link.js");
  try {
    const { confirmed } = await leave({ force });
    console.log(confirmed ? "This server left the Twoody account." : "This server left the Twoody account here; the account did not confirm it, remove it there too.");
    return 0;
  } catch (err) {
    if (!(err instanceof LeaveUnconfirmedError)) throw err;
    console.error(`The account did not confirm (${err.message}); this server is still linked (account.json kept).\nTry again, or run twoody-server logout --force to leave here anyway.`);
    return 1;
  }
}

export async function runAccountCommand(command: string, args: string[]): Promise<number> {
  switch (command) {
    case "login":
      return login();
    case "approve":
      return approve(args);
    case "logout":
      return logout(args);
    default:
      console.error(`unknown command: ${command}`);
      return 2;
  }
}
