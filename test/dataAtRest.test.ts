import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Twoody Server on its own (a Pi) keeps its keys in 0600 files; what
// protects them when the card or the disk is taken is an encrypted volume.
// dataAtRest.ts says whether DATA_DIR is on one, and never more than it
// knows; with TWOODY_DATA_ENCRYPTION=require the server will not start
// elsewhere (a LUKS volume not mounted yet).
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-data-at-rest-"));

const { checkDataAtRest, mountOf, refusalToStart } = await import("../src/dataAtRest.js");
const { buildApp } = await import("../src/app.js");

const RASPBIAN = [
  "22 1 179:2 / / rw,noatime shared:1 - ext4 /dev/mmcblk0p2 rw",
  "25 22 179:1 / /boot/firmware rw,relatime shared:3 - vfat /dev/mmcblk0p1 rw",
  "30 22 0:26 / /run rw,nosuid shared:5 - tmpfs tmpfs rw",
].join("\n");

/// A Linux machine made of files: /proc/self/mountinfo, /sys's links and
/// device-mapper uuids.
function linux(files: Record<string, string>, { links = {} as Record<string, string>, dirs = {} as Record<string, string[]>, lsattr = "" } = {}) {
  const exists = (path: string) => path in files || path in links || path in dirs || Object.keys(files).some((f) => f.startsWith(`${path}/`)) || path === "/" || path.startsWith("/srv") || path.startsWith("/home");
  return {
    platform: "linux" as NodeJS.Platform,
    readFile: (path: string) => {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path]!;
    },
    readdir: (path: string) => {
      if (!(path in dirs)) throw new Error("ENOENT");
      return dirs[path]!;
    },
    realpath: (path: string) => links[path] ?? path,
    exists,
    run: (file: string) => {
      if (file === "lsattr" && lsattr) return lsattr;
      throw new Error("no such program");
    },
  };
}

test("the Pi's SD card, as Raspberry Pi OS sets it up: not encrypted", () => {
  const deps = linux({ "/proc/self/mountinfo": RASPBIAN }, { links: { "/sys/dev/block/179:2": "/sys/devices/platform/mmc/block/mmcblk0/mmcblk0p2" }, dirs: { "/sys/devices/platform/mmc/block/mmcblk0/mmcblk0p2/slaves": [] } });
  assert.equal(checkDataAtRest("/home/pi/.twoody/data", deps), "not_encrypted");
});

test("a LUKS volume mounted on /srv/twoody: encrypted; and LVM on LUKS too", () => {
  const mountinfo = `${RASPBIAN}\n40 22 254:0 / /srv/twoody rw,noatime - ext4 /dev/mapper/twoody rw`;
  const deps = linux(
    { "/proc/self/mountinfo": mountinfo, "/sys/devices/virtual/block/dm-0/dm/uuid": "CRYPT-LUKS2-0123456789abcdef-twoody\n" },
    { links: { "/sys/dev/block/254:0": "/sys/devices/virtual/block/dm-0", "/sys/dev/block/179:2": "/sys/block/mmcblk0p2" } },
  );
  assert.equal(checkDataAtRest("/srv/twoody/data", deps), "encrypted");
  // Elsewhere on the same machine, still the card.
  assert.equal(checkDataAtRest("/home/pi/.twoody/data", { ...deps, readdir: () => [] }), "not_encrypted");

  const lvm = linux(
    {
      "/proc/self/mountinfo": mountinfo,
      "/sys/devices/virtual/block/dm-0/dm/uuid": "LVM-abc\n",
      "/sys/class/block/dm-1/dm/uuid": "CRYPT-LUKS2-xyz\n",
    },
    { links: { "/sys/dev/block/254:0": "/sys/devices/virtual/block/dm-0" }, dirs: { "/sys/devices/virtual/block/dm-0/slaves": ["dm-1"] } },
  );
  assert.equal(checkDataAtRest("/srv/twoody/data", lvm), "encrypted");
});

test("attack on the check: LVM spanning an encrypted and a clear disk is not called encrypted", () => {
  const mountinfo = `${RASPBIAN}\n40 22 254:0 / /srv/twoody rw - ext4 /dev/mapper/vg-data rw`;
  const deps = linux(
    { "/proc/self/mountinfo": mountinfo, "/sys/devices/virtual/block/dm-0/dm/uuid": "LVM-abc", "/sys/class/block/dm-1/dm/uuid": "CRYPT-LUKS2-xyz" },
    { links: { "/sys/dev/block/254:0": "/sys/devices/virtual/block/dm-0" }, dirs: { "/sys/devices/virtual/block/dm-0/slaves": ["dm-1", "sda2"], "/sys/class/block/sda2/slaves": [] } },
  );
  assert.equal(checkDataAtRest("/srv/twoody/data", deps), "not_encrypted");
});

test("a folder whose volume is not mounted is on the card underneath; a stacked filesystem and fscrypt count", () => {
  const deps = linux({ "/proc/self/mountinfo": RASPBIAN }, { links: { "/sys/dev/block/179:2": "/sys/block/mmcblk0p2" } });
  assert.equal(checkDataAtRest("/srv/twoody/data", { ...deps, exists: (p: string) => p === "/" || p === "/sys/dev/block/179:2", readdir: () => [] }), "not_encrypted");
  const gocryptfs = linux({ "/proc/self/mountinfo": `${RASPBIAN}\n41 22 0:50 / /srv/twoody rw - fuse.gocryptfs /srv/.twoody-cipher rw` });
  assert.equal(checkDataAtRest("/srv/twoody/data", gocryptfs), "encrypted");
  const fscrypt = linux({ "/proc/self/mountinfo": RASPBIAN }, { lsattr: "-----E---------e------- /home/pi/.twoody/data\n" });
  assert.equal(checkDataAtRest("/home/pi/.twoody/data", fscrypt), "encrypted");
  // lsattr's lowercase "e" (extents) is not encryption.
  const extents = linux({ "/proc/self/mountinfo": RASPBIAN }, { lsattr: "--------------e------- /home/pi/.twoody/data\n", links: { "/sys/dev/block/179:2": "/sys/block/mmcblk0p2" } });
  assert.equal(checkDataAtRest("/home/pi/.twoody/data", { ...extents, readdir: () => [] }), "not_encrypted");
});

test("what cannot be told is said as unknown: no /proc, a tmpfs, Windows", () => {
  assert.equal(checkDataAtRest("/srv/x", linux({})), "unknown");
  assert.equal(checkDataAtRest("/run/twoody", linux({ "/proc/self/mountinfo": RASPBIAN })), "unknown");
  assert.equal(checkDataAtRest("C:\\twoody", { ...linux({}), platform: "win32" }), "unknown");
});

test("macOS: FileVault on the volume that holds the folder", () => {
  const mac = (vault: string) => ({
    ...linux({}),
    platform: "darwin" as NodeJS.Platform,
    exists: () => true,
    run: (file: string, args: string[]) => {
      if (file === "/bin/df") return "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s5 100 50 50 50% /System/Volumes/Data\n";
      assert.deepEqual(args, ["info", "-plist", "/System/Volumes/Data"]);
      return `<dict><key>FileVault</key>\n\t<${vault}/></dict>`;
    },
  });
  assert.equal(checkDataAtRest("/Users/x/data", mac("true")), "encrypted");
  assert.equal(checkDataAtRest("/Users/x/data", mac("false")), "not_encrypted");
});

test("mount points with spaces are read as mountinfo writes them", () => {
  assert.equal(mountOf("/mnt/my disk/data", `${RASPBIAN}\n50 22 8:1 / /mnt/my\\040disk rw - ext4 /dev/sda1 rw`)?.point, "/mnt/my disk");
});

test("TWOODY_DATA_ENCRYPTION=require refuses to start anywhere but on an encrypted volume", () => {
  const card = linux({ "/proc/self/mountinfo": RASPBIAN }, { links: { "/sys/dev/block/179:2": "/sys/block/mmcblk0p2" } });
  const clear = { ...card, readdir: () => [] };
  assert.equal(refusalToStart({}, "/srv/twoody/data", clear), null);
  assert.match(refusalToStart({ TWOODY_DATA_ENCRYPTION: "require" }, "/srv/twoody/data", clear) ?? "", /not on an encrypted volume/);
  assert.match(refusalToStart({ TWOODY_DATA_ENCRYPTION: "require" }, "/srv/x", linux({})) ?? "", /cannot be told/);
  const luks = linux(
    { "/proc/self/mountinfo": `${RASPBIAN}\n40 22 254:0 / /srv/twoody rw - ext4 /dev/mapper/twoody rw`, "/sys/devices/virtual/block/dm-0/dm/uuid": "CRYPT-LUKS2-x" },
    { links: { "/sys/dev/block/254:0": "/sys/devices/virtual/block/dm-0" } },
  );
  assert.equal(refusalToStart({ TWOODY_DATA_ENCRYPTION: "require" }, "/srv/twoody/data", luks), null);
});

test("/health and the status the person's other computers read say it; the heartbeat to the account does not", async () => {
  const app = await buildApp();
  const health = (await app.inject({ url: "/health" })).json();
  assert.ok(["encrypted", "not_encrypted", "unknown"].includes(health.data_at_rest));
  const { buildStatus } = await import("../src/account/statusSource.js");
  assert.equal("data_at_rest" in (await buildStatus()), false);
  const { readStatus } = await import("../src/account/status.js");
  const base = { app_version: "1", models: [], load: { cpu_pct: null, gpu_pct: null, ram_used_pct: null, at: null }, tps: {}, inflight: 0, accepts: [], tools: false };
  assert.equal(readStatus({ ...base, data_at_rest: "not_encrypted" })?.data_at_rest, "not_encrypted");
  assert.equal("data_at_rest" in (readStatus({ ...base, data_at_rest: "<script>" }) ?? {}), false);
  const peerRoute = (await import("node:fs")).readFileSync(new URL("../src/routes/peer.ts", import.meta.url), "utf8");
  assert.match(peerRoute, /data_at_rest: dataAtRest\(DATA_DIR\)/);
  await app.close();
});

test("the requirement is checked before anything opens the database", () => {
  const index = (require_("../src/index.ts"));
  assert.ok(index.indexOf('import "./dataGuard.js"') > 0);
  assert.ok(index.indexOf('import "./dataGuard.js"') < index.indexOf('from "./db.js"'));
  assert.ok(index.indexOf('import "./dataGuard.js"') < index.indexOf('from "./app.js"'));
});

function require_(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}
