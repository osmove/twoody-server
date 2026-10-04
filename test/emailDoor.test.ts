import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// « E-mails »: IMAP is raw TCP, which the HTTP gate (outbound.ts
// outboundFetch) never sees. The connection to a mail server passes its
// own door instead: E-mails on, the server the person set up — exactly —
// and TLS (in clear to this machine only); and there is one place that
// opens one. Nothing sends e-mails.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-email-door-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { isLoopbackHost, mailServerDoor, MailDoorClosedError, validMailHost } = await import("../src/outbound.js");
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
