# Publishing Twoody Server

Four things are published, all from Jimmy's accounts, never from CI
without being asked:

| What | Where | Source |
|------|-------|--------|
| `twoody-server` | npm | this repository |
| `twoody` | npm | `~/Dev/twoody/twoody-npm` (wrapper, depends on `twoody-server`) |
| `twoody` | PyPI | `~/Dev/twoody/twoody-pypi` (launcher, runs `npx twoody-server@<version>`) |
| `ghcr.io/osmove/twoody-server` | GitHub Container Registry | this repository, `.github/workflows/docker.yml` |

Order: the Docker image and `twoody-server` first, then `twoody` (npm),
which depends on it, then `twoody` (PyPI), which runs it.

## Before the first release

- **npm**: the `jimdou` account owns `twoody-server` and `twoody`
  (`npm owner ls twoody-server`). `npm login`, with two-factor
  authentication on.
- **The `twoody` name on npm is also claimed by twoody-cli**
  (`~/Dev/twoody/twoody-cli`, package name `twoody`, bin `twoody`, and its
  `release.yml` runs `npm publish` with `NPM_TOKEN`). Decide which one the
  name goes to before publishing either; the other needs a new name (or
  the CLI takes a `twoody server` subcommand that runs this server).
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
  (`dist/`) under BUSL-1.1, not the TypeScript sources. `package.json`
  has no `repository` field on purpose, because the repository is private.

## Each release

Bump the version in the three places that name it:

1. `twoody-server/package.json` → `version` (then `npm install
   --package-lock-only`), commit.
2. `twoody-npm/package.json` → `version` and the `twoody-server`
   dependency range.
3. `twoody-pypi/pyproject.toml` → `version`, and
   `src/twoody/__init__.py` → `__version__` and `SERVER_VERSION`.

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

```bash
rm -rf /tmp/twoody-server-release
git clone ~/Dev/twoody/twoody-server /tmp/twoody-server-release
cd /tmp/twoody-server-release
npm ci
npm run typecheck && npm test
npm pack --dry-run          # bin/, dist/, openapi.json, README.md, LICENSE, package.json
npm publish                 # prepack empties dist/ and runs tsc
npm view twoody-server version
```

### 3. npm: `twoody`

```bash
cd ~/Dev/twoody/twoody-npm
npm pack --dry-run          # bin/twoody.mjs, README.md, package.json
npm publish
npm install -g twoody && twoody --version
```

### 4. PyPI: `twoody`

```bash
cd ~/Dev/twoody/twoody-pypi
rm -rf dist
python3 -m build
python3 -m twine check dist/*
python3 -m twine upload dist/*     # user: __token__, password: the API token
pipx run twoody --version          # or: pip install twoody in a venv
```
