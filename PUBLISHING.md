# Publishing Twoody Server

## State on 31 October 2026

Publishing is Jimmy's to do (his npm, PyPI and GitHub accounts); an agent
prepares and checks, it does not publish. As of today:

| Where | What is there |
|-------|---------------|
| npm `twoody-server` | `0.2.3` (latest), published 1 November 2026 from a clean clone of `1620cf1` (the Desktop installs the models `twoody pull` asks for, a taken port said in words); `0.2.2` published 31 October 2026 from a clean clone of tag `v0.2.2` (`twoody-server api-key`; shasum 60af0b2a…); `0.2.1` the same morning: drizzle-orm 0.45, zod removed, `npm audit` clean; `0.2.0` on 30 October |
| npm `twoody` | `0.2.1` (latest), published 1 November 2026 from a clean clone of `ca2f181` (starts Twoody Server in the background, clearer errors, `run` installs a missing model); `0.2.0` on 31 October; `0.1.0` was the old CLI |
| PyPI `twoody` | `0.2.0`, published 31 October 2026 (account `jimdou`); runs `twoody@0.2.0` from npm |
| Homebrew `osmove/twoody/twoody` | formula for `twoody` 0.2.0 (0.2.1 to push from the afternoon of 2 November 2026, 24 h after `twoody-server` 0.2.3); Homebrew's npm only takes packages published more than a day ago, so `brew install` works from the evening of 31 October 2026 (24 h after `twoody-server` 0.2.0) |
| `ghcr.io/osmove/twoody-server` | `0.2.3` (latest, 1 November 2026, from the tag `v0.2.3`); public since 31 October 2026 (the organization's package settings allow public packages); checked by an anonymous pull: `twoody-server api-key create` in the container, `/v1/models` from the host with `-e TWOODY_API_ALLOW_NETWORK=1 -p 127.0.0.1:3000:3000` |
| `https://twoody.com/install.sh` | 404 |

`twoody-cli` depends on `twoody-server ^0.2.1`, so an installed `twoody`
takes the newest 0.2.x server from 0.2.1 on.

Build the PyPI files from a clean copy (`git archive HEAD`) right before
uploading: on 31 October the `dist/` of the working copy still held a 0.2.0
built on 29 September under another licence. A version number can never be
uploaded twice to PyPI.

## What gets published

Four things are published, all from Jimmy's accounts, never from CI
without being asked:

| What | Where | Source |
|------|-------|--------|
| `twoody-server` | npm | this repository |
| `twoody` | npm | `~/Dev/twoody/twoody-cli` (the Twoody CLI; depends on `twoody-server`, whose server `twoody serve` starts) |
| `twoody` | PyPI | `~/Dev/twoody/twoody-pypi` (launcher, runs `npx twoody@<version>`) |
| `ghcr.io/osmove/twoody-server` | GitHub Container Registry | this repository, `.github/workflows/docker.yml` |

Order: the Docker image and `twoody-server` first, then `twoody` on npm
(from twoody-cli), which depends on it, then `twoody` on PyPI, which runs
it. `~/Dev/twoody/twoody-npm` is superseded (29/09/2026): the `twoody` npm
name went to twoody-cli, whose `twoody serve` replaced it. Do not publish
from twoody-npm.

## Before the first release

- **npm**: the `jimdou` account owns `twoody-server` and `twoody`
  (`npm owner ls twoody-server`). `npm login`, with two-factor
  authentication on. `twoody@0.1.0` on npm is the old CLI, whose
  postinstall downloaded a binary from the (private, release-less)
  twoody-cli GitHub repository: 0.2.0 replaces it.
- **twoody-cli's own workflow** (`.github/workflows/release.yml`, run by
  hand with a tag) also publishes `twoody` to npm with the `NPM_TOKEN`
  secret when the repository variable `PUBLISH_NPM` is `true`: it runs
  `npm ci`, `npm test`, then `npm publish --access public` (`prepack`
  bundles `lib/twoody.mjs` with Bun). Publish `twoody` either from there or
  by hand (below), not both. It no longer publishes to PyPI.
- **PyPI**: an account on pypi.org with two-factor authentication, and an
  API token (account-wide for the first upload, since the project does
  not exist yet; replace it with a token scoped to `twoody` afterwards).
  Tools: `python3 -m pip install --user build twine`.
- **GitHub Container Registry**: in `osmove` → Settings → Actions →
  General, workflow permissions must let `GITHUB_TOKEN` write packages
  (the workflow asks for `packages: write`). The repository is private, so
  the first image is pushed as a **private** package: then open
  github.com/orgs/osmove/packages → `twoody-server` → Package settings →
  Change visibility → Public, or every Pi has to `docker login ghcr.io`.
- **License**: the npm tarball and the image carry the compiled server
  (`dist/`, without comments), not the TypeScript sources, under the
  proprietary LICENSE (free use under Twoody's terms of use). `package.json`
  has no `repository` field on purpose, because the repository is private.
  twoody-cli and twoody-pypi carry the same LICENSE.

## Each release

Bump the version in the places that name it:

1. `twoody-server/package.json` → `version` (then `npm install
   --package-lock-only`), commit.
2. `twoody-cli/package.json` → `version` and the `twoody-server`
   dependency range. After `twoody-server` is on npm (step 2 below), run
   `npm install --package-lock-only` in twoody-cli and commit the lockfile:
   until then it cannot hold `twoody-server`, and `npm ci` (CI, the release
   workflow) refuses it.
3. `twoody-pypi/pyproject.toml` → `version`, and
   `src/twoody/__init__.py` → `__version__` and `NPM_VERSION` (the
   `twoody` npm release it runs).

### 1. Docker image

Either push a tag (the workflow runs on `v*` and pushes `0.2.0`, `0.2`
and `latest`):

```bash
cd ~/Dev/twoody/twoody-server
git tag v0.2.0 && git push origin main v0.2.0
```

or run it by hand (pushes the branch name and `sha-<commit>`, not
`latest`):

```bash
gh workflow run docker.yml --repo osmove/twoody-server --ref main
gh run watch --repo osmove/twoody-server
```

Check: `docker pull ghcr.io/osmove/twoody-server:0.2.0` on a Pi, then
`docker run --rm ghcr.io/osmove/twoody-server:0.2.0 --version`.

### 2. npm: `twoody-server`

Publish from a clean clone, not from the shared checkout: `prepack`
builds whatever is in `src/`, other sessions' unfinished work included.
Clone it in a plain folder of the home folder, never under `/tmp` nor in a
hidden folder: some tests add a folder of the clone to Documents, and
Twoody refuses temporary and hidden folders (18 failures from
`/tmp/twoody-server-release` on 1 November 2026).

```bash
rm -rf ~/twoody-server-release
git clone ~/Dev/twoody/twoody-server ~/twoody-server-release
cd ~/twoody-server-release
npm ci
npm run typecheck && npm test
npm pack --dry-run          # bin/, dist/, openapi.json, README.md, LICENSE, package.json
npm publish                 # prepack empties dist/ and runs tsc
npm view twoody-server version
```

### 3. npm: `twoody` (from twoody-cli)

Needs Bun (`prepack` bundles the CLI into `lib/twoody.mjs`). From a clean
clone, for the same reason as the server:

```bash
cd ~/Dev/twoody/twoody-cli
npm install --package-lock-only && git commit -m "Lock twoody-server 0.2.0" package-lock.json
rm -rf ~/twoody-cli-release
git clone ~/Dev/twoody/twoody-cli ~/twoody-cli-release
cd ~/twoody-cli-release
npm ci
npm test
npm pack --dry-run          # bin/twoody.js, lib/twoody.mjs, README.md, LICENSE, package.json
npm publish --access public
npm install -g twoody && twoody --version && twoody serve --help
```

Or run twoody-cli's release workflow with the tag (it builds the Homebrew
binaries too and publishes to npm when `PUBLISH_NPM` is `true`):

```bash
cd ~/Dev/twoody/twoody-cli
git tag v0.2.0 && git push origin main v0.2.0
gh workflow run release.yml --repo osmove/twoody-cli -f tag=v0.2.0
```

End-to-end check of an installed `twoody` (any of npm, PyPI):
`TWOODY_BIN=$(which twoody) node scripts/smoke-serve.mjs` in twoody-cli
(`twoody serve` with a fake model runtime, `/health`, an account, `twoody
ask` with `--effort`/`--model`/`--documents`, `twoody models`, `twoody
folders`).

### 4. PyPI: `twoody`

```bash
cd ~/Dev/twoody/twoody-pypi
rm -rf dist
python3 -m build
python3 -m twine check dist/*
python3 -m twine upload dist/*     # user: __token__, password: the API token
pipx run twoody --launcher-version  # or: pip install twoody in a venv
pipx run twoody serve --help
```
