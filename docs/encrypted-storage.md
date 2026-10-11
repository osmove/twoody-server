# Twoody Server's data on an encrypted volume

11 October 2026. For Twoody Server running on its own (a Raspberry Pi, a NAS, a
Linux box): no Twoody Desktop, nobody at the screen.

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
