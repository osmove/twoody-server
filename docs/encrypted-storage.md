# Twoody Server's data on an encrypted volume

11 October 2026. For Twoody Server running on its own (a Raspberry Pi, a NAS, a
Linux box): no Twoody Desktop, nobody at the screen. Inside Twoody Desktop, the
database itself is encrypted since 12 October 2026: see « Inside Twoody
Desktop » at the end.

## Why

Inside Twoody Desktop, this computer's keys (tunnel key, encrypted-history keys,
sealed-turn keys, session tokens) are sealed by the system's protected storage:
the macOS Keychain, Windows DPAPI, the Linux keyring. Twoody Server on its own
has no one to unlock a keyring when it boots, so it keeps them in files only its
own user can read (0600) in its data folder (`TWOODY_DATA_DIR`, `~/.twoody/data`
by default), next to its database and the decrypted copies of the history.

That protects them from the other accounts of the same machine. It does not
protect them from someone who takes the SD card or the disk: they read every
file. Encrypting the files with a key kept on the same disk would change
nothing, and Twoody does not pretend to. What does protect them is an encrypted
volume whose key is not on the disk.

## What Twoody does

- At start, Twoody Server looks at whether its data folder is on an encrypted
  volume (`src/dataAtRest.ts`): dm-crypt / LUKS under the folder's mount (also
  through LVM or RAID, every member encrypted), ecryptfs, gocryptfs and the
  like, fscrypt on the folder; FileVault on macOS. It says `encrypted`,
  `not_encrypted`, or `unknown` when it cannot tell (Windows, ZFS, Docker
  overlays…).
- `not_encrypted` is said in the log at start, in `GET /health`
  (`data_at_rest`), and to the person's other computers in its status
  (`GET /api/v1/peer/status`, sealed): Twoody Desktop shows it in « Appareils »
  under that computer. The account (twoody.com) is never told.
- `TWOODY_DATA_ENCRYPTION=require` (in `/etc/twoody-server.env`): the server
  refuses to start unless the folder is on an encrypted volume (exit code 78).
  Use it once the volume below is set up: if the volume is not mounted after a
  reboot, the server does not quietly make a new, clear data folder on the card
  underneath.

## Setting it up on Raspberry Pi OS (Bookworm)

The simplest setup that really protects the data: a LUKS volume for the data
folder only, opened by hand over SSH after each reboot. Until it is opened, the
server does not start and the person's devices see this computer as offline.
These steps have not been run on Jimmy's Pi; read them through before you start,
and keep a copy of the passphrase somewhere safe: without it the data is gone.

1. Install the tools: `sudo apt install cryptsetup`.
2. Make the volume. Either a USB disk partition (this **erases** it; check the
   name with `lsblk`):

   ```sh
   sudo cryptsetup luksFormat --type luks2 /dev/sda1
   sudo cryptsetup open /dev/sda1 twoody
   ```

   or a container file on the card (8 GB here; the models take room, see
   `DATA_DIR/models`):

   ```sh
   sudo fallocate -l 8G /srv/twoody.luks
   sudo chmod 600 /srv/twoody.luks
   sudo cryptsetup luksFormat --type luks2 /srv/twoody.luks
   sudo cryptsetup open /srv/twoody.luks twoody
   ```

   A Raspberry Pi 5 has the ARMv8 AES instructions, so the default cipher
   (aes-xts-plain64) is fast. On a Pi 4, which has not, use
   `--cipher xchacha20,aes-adiantum-plain64` with `luksFormat`.
3. Make the file system and the data folder:

   ```sh
   sudo mkfs.ext4 -L twoody /dev/mapper/twoody
   sudo mkdir -p /srv/twoody
   sudo mount /dev/mapper/twoody /srv/twoody
   sudo install -d -o pi -g pi -m 700 /srv/twoody/data
   ```

4. Move the data (the service stopped):

   ```sh
   sudo systemctl stop twoody-server
   sudo rsync -a /home/pi/.twoody/data/ /srv/twoody/data/
   sudo chown -R pi:pi /srv/twoody/data
   mv /home/pi/.twoody/data /home/pi/.twoody/data.clear-old
   ```

5. In `/etc/twoody-server.env`:

   ```sh
   TWOODY_DATA_DIR=/srv/twoody/data
   TWOODY_DATA_ENCRYPTION=require
   ```

   and in the unit (`sudo systemctl edit twoody-server`):

   ```ini
   [Service]
   ReadWritePaths=/srv/twoody
   RestartPreventExitStatus=78
   ```

6. Start it: `sudo systemctl start twoody-server`, then
   `curl -s 127.0.0.1:3000/health` must say `"data_at_rest":"encrypted"`.
7. Once everything works, delete `/home/pi/.twoody/data.clear-old`. On an SD
   card or an SSD, deleted blocks can stay readable: the keys that were ever on
   the clear card are only as safe as that card. If it leaves your hands, pair
   the devices again (new keys) rather than trust the old ones.

After each reboot:

```sh
ssh pi@<the Pi>
sudo cryptsetup open /srv/twoody.luks twoody   # or /dev/sda1
sudo mount /dev/mapper/twoody /srv/twoody
sudo systemctl restart twoody-server
```

Twoody's own user service on Jimmy's Pi (`twoody-next`, AGENTS.md §6) works the
same way, with its data folder (`~/twoody-next/data`) and
`systemctl --user restart twoody-next`.

### Without typing a passphrase at each boot

- **Clevis and Tang** (`apt install clevis clevis-luks tang`): the volume opens
  by itself while the Pi can reach a Tang server on the home network (another
  computer of the house). A disk or a Pi taken out of the house stays locked;
  someone who takes the Pi *and* that computer can open it. Bind with
  `sudo clevis luks bind -d /dev/sda1 tang '{"url":"http://<tang host>"}'` and
  open with `sudo clevis luks unlock -d /dev/sda1 -n twoody` before the service
  starts.
- **A key file on a USB stick** protects only if the stick is kept apart from
  the Pi, which a computer that reboots alone cannot have.
- **A key file on the same card** protects nothing.

### Why not systemd-creds

`systemd-creds` encrypts a secret either with a TPM2 chip, binding it to the
board, or with a host key in `/var/lib/systemd/credential.secret`. A Raspberry
Pi has no TPM2, so the host key would sit on the same card as what it protects:
someone who takes the card has both. It would add nothing over the 0600 files
against that, and Twoody does not use it. On a machine with a TPM2, a LUKS
volume bound to it (`systemd-cryptenroll --tpm2-device=auto`) is the better
place to start.

## Inside Twoody Desktop: the database encrypted (12 October 2026)

Inside Twoody Desktop there is a person to unlock a keyring, so the database is
encrypted by Twoody itself, whatever the disk.

### What is encrypted

- `server/local.db` and its `-wal`: conversations, memories, the document index
  and its vectors, e-mails, contacts and events, bank statements, traces with
  their prompts. Every page, in the file and in the WAL (`-shm` holds only the
  WAL's index of page numbers).
- The migration backups (`server/backups/*.db`, `migrations/index.ts`): a new
  one is written with `VACUUM INTO`, which keeps the cipher and the key; those
  earlier versions wrote in clear are encrypted at the first start with a key,
  in a worker thread (`dbCipherWorker.ts`), each checked like the database.
- Already sealed by the Desktop, unchanged: the encrypted history's keys and
  its outbox (`vault/<id>-history.json`, safeStorage), the tunnel key, the keys
  of sealed turns, the tokens.
- The secret files next to the database (12/10/2026, « Secret files » below):
  `connectors.json` (the connectors' OAuth tokens), `email-credentials.json` (a
  mailbox's password or refresh token), `google-data.json` and
  `microsoft-graph.json` (refresh tokens), `account.json` (the pairing key),
  `warm-seeds.json` (the person's name and granted folders' paths); and the
  Desktop's own Twoody Code and Agent sessions (`code/`, `office/`,
  `mobile-agent/` `sessions/*.json` and the text of the documents joined to
  them).
- **Not covered**: temporary files of a voice message or an image live a few
  seconds in the system's temporary folder; `server.log` and the crash
  reports hold no conversation; the models and the documents themselves are
  the person's files, where they are.

### How

- Driver: `better-sqlite3-multiple-ciphers` 13.0.3 (MIT), better-sqlite3 built
  with SQLite3 Multiple Ciphers 2.4.0 (SQLite 3.53.4), the same API and the
  same N-API prebuilds (darwin arm64/x64, win32 x64/arm64, linux x64/arm64,
  glibc and musl) as better-sqlite3 13: one native module for Node and every
  Electron, nothing compiled. Twoody Server on its own uses it too, without a
  key: a plain SQLite.
- Scheme: SQLCipher 4 (`cipher = 'sqlcipher'`, `legacy = 4`): AES-256-CBC per
  4096-byte page with a random IV at each write, HMAC-SHA512 per page (a page
  changed on disk does not open), a random 16-byte salt per file. The key is
  raw: 256 random bits (`x'…'`), so no PBKDF2 (SQLCipher skips it for raw
  keys); the HMAC key is derived from it and the salt, as SQLCipher does. A
  file opens in SQLCipher 4 itself with `PRAGMA key = "x'<hex>'"`.
- The key: made by the Desktop (`src/main/databaseKey.ts`,
  `crypto.randomBytes`), sealed by safeStorage (Keychain, DPAPI, libsecret) in
  `server/database-key.sealed`, read back before it is handed over, and given to
  the server by message before db.ts opens the file (`dbKeyHandOver.ts`,
  `TWOODY_DB_KEY_STORE=desktop`). Never in the environment, a file in clear, a
  log or a message back.
- Without protected storage (Linux without an unlocked keyring, safeStorage's
  `basic_text`) the database stays in clear, as the tunnel key stays in its
  0600 file (Desktop 9705b2a): a key kept next to the database would protect
  nothing, and refusing to start would leave the person without Twoody on many
  Linux desktops. `data_at_rest` still says whether the volume is encrypted;
  the database is encrypted at the first start with a keyring.
- An encrypted database the server cannot open — the keyring locked or gone,
  the key lost or not the one — is never replaced: the server says why and
  stops (exit 78, `db-refused`), the Desktop shows « Twoody's database is
  encrypted, and its key is in a keyring that cannot be opened now… » or
  « …no longer has the key that opens it. Nothing was changed or deleted. ». A
  server started over the Desktop's folder without its key store (an older
  Desktop after a downgrade, `twoody serve` pointed at it) stops the same way.
- `GET /health` says `database`: `encrypted` or `clear`.

### Secret files

Inside Twoody Desktop, with the database key of the run (only when the
database is encrypted), `src/secretFile.ts` seals the files above:

- Key: HKDF-SHA256 (RFC 5869) of the 256-bit database key, salt « twoody
  secret files », info « twoody/secret-file/v1:<file name> » — one key per
  file, none of them the database's. The Desktop's sessions use the same
  derivation with their place as the name (« code/sessions/<id>.json »,
  `twoody-desktop/src/main/secretFile.ts`).
- Cipher: AES-256-GCM, a 96-bit nonce drawn at each write, a 128-bit tag, the
  same info as associated data (a sealed file put in another's place does not
  open). Written `{"twoody":"sealed-file","v":1,"alg":"HKDF-SHA256+AES-256-GCM",
  iv, tag, data}`, 0600, through a temporary file. Both repositories' tests
  hold the same test vector.
- No algorithm that was not already used and declared (the tunnel and the
  pairing envelope use HKDF-SHA256 and AES-256-GCM); new is only their use for
  storage.
- A file an earlier version wrote in clear is sealed at start, before any
  module reads it (`sealSecretFilesInPlace`, from db.ts): sealed text written
  to `<name>.sealing`, flushed, read back and compared, then the clear file
  moved into `secrets.unsealed-<date>/` and the sealed one renamed in its
  place; the folder goes to the Trash through the Desktop (`db-trash`,
  `trashableClearCopy` accepts that folder in the server's own folder only).
  Cut off between the renames, the next start puts the checked sealed copy in
  place, or gives the clear one back. The Desktop seals its sessions the same
  way once the server says it is done (`db-cleanup-done`), with the key it
  keeps sealed (`peek`: never one made for them).
- A sealed file this run cannot open (no key) is never written over nor
  removed (`SecretFileLockedError`); in practice the server does not start
  then, its database being encrypted too.
- On its own (Pi, `twoody serve`): no key, the files stay 0600 as before.

### Encrypting the database of an earlier version

At the first start with a key, before the server listens (`dbCipher.ts`
`encryptDatabaseFile`; the Desktop waits up to an hour for it, told by
`db-encryption` messages):

1. Free space checked: the size of the file and its WAL, plus 5 % and 16 MB.
   Not enough: the database stays in clear for this run, nothing touched.
2. The clear database checkpointed (`wal_checkpoint(TRUNCATE)`), every table's
   row count and the schema version read, closed.
3. Copied to `local.db.encrypting`, its header set to rollback mode (its WAL
   is empty), encrypted there (`PRAGMA rekey`) with no journal at all
   (`journal_mode = OFF` on that copy): no other file of clear pages is
   written, not even for a moment. Cut off, the copy is made again.
4. Checked: the copy is no longer in clear, opens with the key, passes
   `quick_check` (every page decrypted and its HMAC verified), holds the same
   number of rows in every table at the same schema version; then flushed and
   renamed `local.db.encrypted` (checked, waiting).
5. Swapped: `local.db` renamed `local.unencrypted-<date>.db` (its `-wal` and
   `-shm` with it), then `local.db.encrypted` renamed `local.db`.
6. The clear copy sent to the Desktop, which moves it to the Trash
   (`db-trash`; only a file of that name in the server's folder or its
   `backups/`, `trashableClearCopy`). Never deleted (root AGENTS.md rule 6):
   **it stays readable in the Trash until the person empties it.** A copy the
   Trash refused is asked again at the next start. Twoody never empties the
   Trash: once everything is moved (`db-cleanup-done`, after the backups),
   the Desktop says it once, with the size, dismissable and remembered
   (`clearCopies.ts`, « Videz la Corbeille pour effacer l'ancienne copie non
   chiffrée » — the Recycle Bin on Windows, the platform's word everywhere).

While it runs, the server encrypts in a worker thread and tells each step
(`db-encryption` `{state: running, phase: read|copy|encrypt|check, step,
steps, bytes}`); the Desktop shows « Chiffrement de vos données sur cet
ordinateur… » with the steps, the size and the time, and opens when it is
done. A database it cannot open shows « Vos données sont verrouillées »
(keychain locked or refused, key gone or not the one): what happened, that
nothing was changed, what to do, « Réessayer »; the refusal is kept for the
run (no loop of starts, each asking the keychain again) until the person
asks again.

Cut off anywhere, the next start takes it up: a half-made or waiting copy next
to a clear `local.db` is made again from it; `local.db` missing with a checked
copy waiting, the copy is put in place; `local.db` missing with only the clear
file put aside, it goes back in its place (never a new, empty database in front
of the person's data). Any failure leaves the clear database as it was.

Measured on Jimmy's database (copy, 600 MB, 74 tables, 624,000 rows; Mac17,4,
24 GB, other work running): 29 to 56 s, mostly the check (copy 0.4 s, rekey 7
to 16 s, check 17 to 39 s). Each of his six migration backups (~580 MB) takes
about as long, in the background, the server answering meanwhile.

### What it costs

`scripts/db-encryption-bench.ts` on a copy of Jimmy's database, three rounds
of fresh processes, clear (SQLite's default 16 MB page cache) against
encrypted (the server's setting), milliseconds, medians:

| | clear | encrypted |
|---|---|---|
| opening the database (import of db.ts) | 185 | 160 |
| history of the conversation (40 messages) | 0.02 | 0.02 |
| memory search (lexical) | 9.9 | 8.8 |
| conversations' index | 1.1 | 1.0 |
| document search (BM25), first | 430 | 408 |
| document search, then (median / p95) | 453 / 1,433 | 229 / 1,930 |
| every vector of the documents (semantic search), first | 378 | 930 |
| the same, then | 349 | 95 |
| writing a turn (two messages and their index) | 0.27 | 0.59 |

The server's start inside Electron (fork to listening, real utility process):
0.6 to 1.0 s in clear, 1.1 to 1.6 s encrypted.

A page read from the file is decrypted and its HMAC checked in software (this
build's AES has no hardware path: `SQLITE3MC_OMIT_AES_HARDWARE_SUPPORT`), a
page in SQLite's cache is not. With SQLite's default 16 MB cache, the same
document searches took up to ten times as long encrypted (p95 12 s) and the
vector scan thirteen times; with a cache that holds what they read, they are
as fast as in clear or faster once read. So the encrypted database gets a
cache of 1/32 of the memory, 1 GB at most (`encryptedCacheKiB`): it only grows
with the pages read and never beyond the database — Jimmy's 600 MB fit in it
(24 GB: 768 MB). The first search of a run, and any whose pages fall out of the
cache, still pays the decryption (the cold rows). ChaCha20 (SQLite3 Multiple
Ciphers' own default) was measured too: no faster here.

### Debugging

`sqlite3 -readonly … ".backup"` copies ciphertext now. On a Mac,
`node twoody-desktop/scripts/readable-db-copy.mjs <scratch>` makes a readable
copy (root AGENTS.md §7): macOS asks the person to let it read Twoody's
safeStorage secret, the key is never printed nor written, the live database is
only read, the copy is in clear in `<scratch>` (0600) and goes to the Trash once
done. The bench tools (`twoody-bench`) make their own databases in clear
folders and are unchanged.

