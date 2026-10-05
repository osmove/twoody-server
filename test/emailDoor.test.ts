import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// « E-mails »: IMAP is raw TCP, which the HTTP gate (outbound.ts
// outboundFetch) never sees. The connection to a mail server passes its
// own door instead: E-mails on, the server the person set up — exactly —
// and TLS (in clear to this machine only); and there is one place that
// opens one. A mailbox that signs in with Microsoft adds one address to
// it: Microsoft's token endpoint, and nothing else. Nothing sends e-mails.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-email-door-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { isLoopbackHost, mailServerDoor, MailDoorClosedError, MICROSOFT_TOKEN_URL, microsoftTokenDoor, microsoftTokenFetch, validMailHost } = await import("../src/outbound.js");
const { openMailSession, useMailConnectorForTests, MailError, mailErrorCode, packUids } = await import("../src/email/imap.js");

test("UIDs go to the server as a short set: consecutive ones as ranges", () => {
  assert.equal(packUids([5, 1, 2, 3, 3, 9, 10, 12]), "1:3,5,9:10,12");
  assert.equal(packUids(Array.from({ length: 1_000 }, (_, index) => index + 1)), "1:1000");
  assert.equal(packUids([0, -1, 1.5]), "");
});

const gmail = { host: "imap.gmail.com", port: 993 };
const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    return err instanceof MailDoorClosedError ? err.reason : `other: ${String(err)}`;
  }
  return null;
};

test("the door opens only while E-mails is on, towards the server set up, over TLS", () => {
  assert.equal(refusal(() => mailServerDoor({ ...gmail, security: "tls" }, gmail, true)), null);
  assert.equal(refusal(() => mailServerDoor({ host: "IMAP.Gmail.com.", port: 993, security: "tls" }, gmail, true)), null, "the same name, however written");
  assert.equal(refusal(() => mailServerDoor({ ...gmail, security: "tls" }, gmail, false)), "email_off");
  assert.equal(refusal(() => mailServerDoor({ ...gmail, security: "tls" }, null, true)), "not_configured");
  assert.equal(refusal(() => mailServerDoor({ host: "imap.evil.example", port: 993, security: "tls" }, gmail, true)), "other_server");
  assert.equal(refusal(() => mailServerDoor({ host: "imap.gmail.com", port: 143, security: "tls" }, gmail, true)), "other_server", "another port is another door");
  assert.equal(refusal(() => mailServerDoor({ host: "imap.gmail.com", port: 993, security: "starttls" }, gmail, true)), "tls_required");
  assert.equal(refusal(() => mailServerDoor({ host: "imap.gmail.com/x", port: 993, security: "tls" }, { host: "imap.gmail.com/x", port: 993 }, true)), "invalid_server");
  // Proton Mail Bridge, on this machine: STARTTLS (its own certificate).
  assert.equal(refusal(() => mailServerDoor({ host: "127.0.0.1", port: 1143, security: "starttls" }, { host: "127.0.0.1", port: 1143 }, true)), null);
  // The private network is not this machine: TLS there too.
  assert.equal(refusal(() => mailServerDoor({ host: "192.168.1.10", port: 143, security: "starttls" }, { host: "192.168.1.10", port: 143 }, true)), "tls_required");
});

test("Microsoft's token endpoint: that address only, while E-mails is on and the mailbox signs in with Microsoft", () => {
  const token = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
  const door = (target: string, microsoftMailbox = true, emailOn = true) => refusal(() => microsoftTokenDoor(target, { microsoftMailbox, emailOn }));
  assert.equal(MICROSOFT_TOKEN_URL, token);
  assert.equal(door(token), null);
  assert.equal(door("https://LOGIN.microsoftonline.com:443/common/oauth2/v2.0/x/../token"), null, "the same address, however written");
  assert.equal(door(token, true, false), "email_off");
  assert.equal(door(token, false, true), "not_configured", "no mailbox that signs in with Microsoft");
  for (const other of [
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token?x=1",
    "https://login.microsoftonline.com:8443/common/oauth2/v2.0/token",
    "https://user@login.microsoftonline.com/common/oauth2/v2.0/token",
    "http://login.microsoftonline.com/common/oauth2/v2.0/token",
    "https://login.microsoftonline.com.evil.example/common/oauth2/v2.0/token",
    "https://graph.microsoft.com/v1.0/me",
    "https://outlook.office.com/api/v2.0/me/messages",
    "not a url",
  ]) assert.equal(door(other), "other_server", other);
});

test("a request refused at that door never leaves this machine", async () => {
  let reached = 0;
  const local = createServer((_req, res) => {
    reached += 1;
    res.end("{}");
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const elsewhere = `http://127.0.0.1:${(local.address() as AddressInfo).port}/common/oauth2/v2.0/token`;
  const refused = (reason: string) => (err: unknown) => err instanceof MailDoorClosedError && err.reason === reason;
  await assert.rejects(microsoftTokenFetch(elsewhere, { method: "POST" }, { microsoftMailbox: true, emailOn: true }), refused("other_server"));
  await assert.rejects(microsoftTokenFetch(MICROSOFT_TOKEN_URL, { method: "POST" }, { microsoftMailbox: true, emailOn: false }), refused("email_off"));
  await assert.rejects(microsoftTokenFetch(MICROSOFT_TOKEN_URL, { method: "POST" }, { microsoftMailbox: false, emailOn: true }), refused("not_configured"));
  assert.equal(reached, 0);
  await new Promise((resolve) => local.close(resolve));
});

test("this machine, and names that are no names", () => {
  for (const host of ["127.0.0.1", "127.8.0.1", "::1", "[::1]", "localhost", "::ffff:127.0.0.1"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["192.168.1.10", "10.0.0.1", "imap.gmail.com", "localhost.example.com", "::2"]) assert.equal(isLoopbackHost(host), false, host);
  for (const host of ["imap.gmail.com", "ssl0.ovh.net", "127.0.0.1", "[::1]", "mail-1.example.co.uk"]) assert.equal(validMailHost(host), true, host);
  for (const host of ["", "imap gmail.com", "user@imap.gmail.com", "imap.gmail.com:993", "https://imap.gmail.com", "-x.com"]) assert.equal(validMailHost(host), false, host);
});

test("a session refused at the door never reaches the network", async () => {
  let dialled = 0;
  useMailConnectorForTests(async () => {
    dialled += 1;
    throw Object.assign(new Error("refused"), { authenticationFailed: true });
  });
  const settings = { host: "imap.gmail.com", port: 993, security: "tls" as const, username: "jimmy@example.org", password: "app-password" };
  await assert.rejects(openMailSession(settings, { configured: gmail, emailOn: false }), (err: unknown) => err instanceof MailError && err.code === "email_off");
  await assert.rejects(openMailSession(settings, { configured: { host: "imap.mail.me.com", port: 993 }, emailOn: true }), (err: unknown) => err instanceof MailError && err.code === "other_server");
  assert.equal(dialled, 0);
  // Through the door: what the server answered, said as a code.
  await assert.rejects(openMailSession(settings, { configured: gmail, emailOn: true }), (err: unknown) => err instanceof MailError && err.code === "auth_failed");
  assert.equal(dialled, 1);
  useMailConnectorForTests(null);
});

test("errors said as a few words, never the server's own text", () => {
  assert.equal(mailErrorCode(Object.assign(new Error("x"), { code: "ENOTFOUND" })), "host_not_found");
  assert.equal(mailErrorCode(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), "unreachable");
  assert.equal(mailErrorCode(Object.assign(new Error("x"), { code: "CONNECT_TIMEOUT" })), "timeout");
  assert.equal(mailErrorCode(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })), "tls_failed");
  assert.equal(mailErrorCode(Object.assign(new Error("NO [AUTHENTICATIONFAILED] Invalid credentials (Failure) jimmy@example.org"), { serverResponseCode: "AUTHENTICATIONFAILED" })), "auth_failed");
  assert.equal(mailErrorCode(new Error("anything else")), "failed");
});

test("what the server's own words say, said as a precise code — read in memory, never repeated", () => {
  // As imapflow hands a refused LOGIN over: the response line, its text, its code.
  const refused = (line: string, code = "ALERT") => Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: code, response: `3 NO [${code}] ${line}`, responseText: line });
  const cases: Array<[unknown, string]> = [
    [refused("Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)"), "app_password_required"],
    [refused("IMAP access is disabled for your domain. Please contact your domain administrator for questions about this feature. (Failure)"), "imap_disabled"],
    [refused("Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)"), "imap_disabled"],
    [refused("Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)", "WEBALERT"), "web_login_required"],
    [refused("Web login required: https://support.google.com/mail/answer/78754", "ALERT"), "web_login_required"],
    [refused("Too many simultaneous connections. (Failure)"), "too_many_connections"],
    [Object.assign(new Error("Connection closed"), { code: "NoConnection", response: "* BYE [UNAVAILABLE] Maximum number of connections from user+IP exceeded" }), "too_many_connections"],
    [refused("Invalid credentials (Failure) claire.martin@gmail.com", "AUTHENTICATIONFAILED"), "auth_failed"],
    [Object.assign(new Error("Command failed"), { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }), "auth_failed"],
  ];
  for (const [err, code] of cases) assert.equal(mailErrorCode(err), code, String((err as { responseText?: string }).responseText ?? (err as Error).message));
  // The words go nowhere: a MailError carries the code alone.
  const said = new MailError(mailErrorCode(cases[0]![0]));
  assert.equal(said.message, "app_password_required");
});

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
function sources(dir = srcDir): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

test("one file opens a connection to a mail server, and none opens a raw socket elsewhere", () => {
  const imap = join(srcDir, "email", "imap.ts");
  const offenders = sources()
    .filter(({ path }) => path !== imap)
    .flatMap(({ path, text }) => text.split("\n").map((line, index) => ({ line, where: `${path}:${index + 1}` })))
    .filter(({ line }) => /from\s+["']imapflow["']|new\s+ImapFlow\b|\btls\.connect\(|\bnet\.connect\(|\bcreateConnection\(|from\s+["'](?:node:)?tls["']/.test(line))
    .map(({ where }) => where);
  assert.deepEqual(offenders, []);
  // And that file asks the door before it connects.
  const text = readFileSync(imap, "utf8");
  assert.ok(text.indexOf("mailServerDoor(settings") < text.indexOf("await connector(settings)"));
  // Microsoft's sign-in is renewed in one place (shared with the link to
  // Outlook's calendar and contacts), after its own door; its address is
  // written nowhere else.
  const microsoft = readFileSync(join(srcDir, "microsoft", "token.ts"), "utf8");
  assert.ok(microsoft.indexOf("microsoftTokenDoor(MICROSOFT_TOKEN_URL") > 0 && microsoft.indexOf("microsoftTokenDoor(MICROSOFT_TOKEN_URL") < microsoft.indexOf("await transport("));
  assert.deepEqual(sources().filter(({ text: one }) => /microsoftonline/i.test(one)).map(({ path }) => path), [join(srcDir, "outbound.ts")]);
});

test("nothing sends an e-mail: no SMTP, no sendmail; the only transport writes a draft into memory", () => {
  const all = sources();
  const offenders = all
    .flatMap(({ path, text }) => text.split("\n").map((line, index) => ({ line, where: `${path}:${index + 1}` })))
    .filter(({ line }) => /SMTPTransport|smtp-transport|SMTPPool|sendmail\s*:\s*true|nodemailer\.createTransport\((?![^)]*streamTransport: true)/i.test(line))
    .map(({ where }) => where);
  assert.deepEqual(offenders, []);
  // nodemailer only where the draft is written.
  assert.deepEqual(all.filter(({ text }) => /from\s+["']nodemailer["']/.test(text)).map(({ path }) => path), [join(srcDir, "email", "chat.ts")]);
});
