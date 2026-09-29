import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../db.js";
import { HEX_KEY, newPairingKey } from "./keys.js";

// DATA_DIR/account.json: what makes this server one of the account's
// computers (docs/multi-computer-design.md §2, Server).
//
//   {backend_url, account_id, account_label, user_token, device_token,
//    computer:{id, credential}, pairing_key:{priv, pub}, approvers:[…]}
//
// Written with mode 0600, like the tunnel identity: the user token and the
// computer credential are the account's, and the pairing key is what the
// approvals are sealed with. Before the server is linked it holds only the
// pairing key and the device token, so that the fingerprint advertised on
// the network does not change from one start to the next.
//
// TWOODY_USER_TOKEN and TWOODY_BACKEND_URL, when set, take precedence over
// the file's (the environment is how a server was tied to an account
// before this file existed).

export const DEFAULT_BACKEND_URL = "https://api.twoody.com";

export interface Approver {
  /// X25519 public key (hex) of the device that approved this computer.
  public_key: string;
  kind: "computer" | "phone" | null;
  name: string | null;
}

export interface AccountFile {
  backend_url?: string;
  account_id?: string | number;
  /// The account, masked (j***@gmail.com), for the console.
  account_label?: string;
  user_token?: string;
  device_token: string;
  computer?: { id: string; credential: string; name?: string };
  pairing_key: { priv: string; pub: string };
  approvers: Approver[];
  linked_at?: string;
}

export interface LinkedAccount extends AccountFile {
  backend_url: string;
  user_token: string;
  computer: { id: string; credential: string; name?: string };
}

export function accountPath(): string {
  return join(process.env.TWOODY_DATA_DIR ?? DATA_DIR, "account.json");
}

function valid(raw: unknown): AccountFile | null {
  if (!raw || typeof raw !== "object") return null;
  const file = raw as Record<string, unknown>;
  const key = file.pairing_key as Record<string, unknown> | undefined;
  if (!key || typeof key.priv !== "string" || typeof key.pub !== "string" || !HEX_KEY.test(key.priv) || !HEX_KEY.test(key.pub)) return null;
  if (typeof file.device_token !== "string" || !file.device_token) return null;
  const computer = file.computer as Record<string, unknown> | undefined;
  const approvers = Array.isArray(file.approvers)
    ? (file.approvers as unknown[]).flatMap((entry): Approver[] => {
        const a = entry as Record<string, unknown> | null;
        if (!a || typeof a.public_key !== "string" || !HEX_KEY.test(a.public_key)) return [];
        const kind = a.kind === "computer" || a.kind === "phone" ? a.kind : null;
        return [{ public_key: a.public_key, kind, name: typeof a.name === "string" ? a.name.slice(0, 100) : null }];
      })
    : [];
  return {
    ...(typeof file.backend_url === "string" ? { backend_url: file.backend_url } : {}),
    ...(typeof file.account_id === "string" || typeof file.account_id === "number" ? { account_id: file.account_id } : {}),
    ...(typeof file.account_label === "string" && file.account_label ? { account_label: file.account_label.slice(0, 120) } : {}),
    ...(typeof file.user_token === "string" && file.user_token ? { user_token: file.user_token } : {}),
    device_token: file.device_token,
    ...(computer && (typeof computer.id === "string" || typeof computer.id === "number") && typeof computer.credential === "string"
      ? { computer: { id: String(computer.id), credential: computer.credential, ...(typeof computer.name === "string" ? { name: computer.name } : {}) } }
      : {}),
    pairing_key: { priv: key.priv, pub: key.pub },
    approvers,
    ...(typeof file.linked_at === "string" ? { linked_at: file.linked_at } : {}),
  };
}

/// The file as it is on disk, or null when there is none (or it is not
/// one this version reads).
export function readAccountFile(): AccountFile | null {
  const path = accountPath();
  if (!existsSync(path)) return null;
  try {
    return valid(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/// Written whole, through a temporary file, 0600 from the first byte.
export function writeAccountFile(file: AccountFile): void {
  const path = accountPath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/// The file, made with a fresh pairing key and device token the first time.
export function ensureAccountFile(): AccountFile {
  const existing = readAccountFile();
  if (existing) return existing;
  const file: AccountFile = { device_token: randomUUID(), pairing_key: newPairingKey(), approvers: [] };
  writeAccountFile(file);
  return file;
}

export function removeAccountFile(): void {
  rmSync(accountPath(), { force: true });
}

/// The backend this server talks to, the environment first.
export function backendUrl(file: AccountFile | null = readAccountFile()): string {
  return (process.env.TWOODY_BACKEND_URL ?? file?.backend_url ?? DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

/// The account, when this server is linked to one — with the environment's
/// user token and backend in front of the file's.
export function linkedAccount(file: AccountFile | null = readAccountFile()): LinkedAccount | null {
  if (!file?.computer) return null;
  const userToken = process.env.TWOODY_USER_TOKEN?.trim() || file.user_token;
  if (!userToken) return null;
  return {
    ...file,
    backend_url: backendUrl(file),
    user_token: userToken,
    device_token: process.env.TWOODY_DEVICE_TOKEN?.trim() || file.device_token,
    computer: file.computer,
  };
}

/// Eight hex characters of the pairing key: what Bonjour advertises and
/// the approving screen can compare.
export function fingerprint(file: AccountFile | null = readAccountFile()): string | null {
  return file ? file.pairing_key.pub.slice(0, 8) : null;
}
