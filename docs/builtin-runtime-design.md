# Built-in llama.cpp runtime in twoody-server, and the « Moteur » setting

Status: design, 29/09/2026. Sequenced after docs/multi-computer-design.md.
Goal: a Pi / Linux server / Docker runs Twoody with no Ollama, on the same
llama.cpp and GGUF models as the Desktop; each computer has a « Moteur »
preference (auto | builtin | ollama | lmstudio | mlx | custom).

## 1. Binaries
- Same pinned release as the Desktop: llama.cpp `b11146` (twoody-desktop/scripts/fetch-runtime.mjs),
  assets `llama-b11146-bin-ubuntu-arm64.tar.gz` (Pi, CPU), `...-ubuntu-x64.tar.gz` (CPU),
  `...-macos-arm64.tar.gz` (Metal). Tag + SHA-256 in one place: `src/builtin/runtimeManifest.ts`,
  which the Desktop's fetch script imports.
- Linux CPU-only in v1 (Vulkan later); no official Linux CUDA build → NVIDIA stays on Ollama.
- Hosts allowlisted: github.com, objects.githubusercontent.com, release-assets.githubusercontent.com; redirects checked by hand.
- npm: lazy download (`twoody-server runtime install` or first model install from an app), never postinstall.
  Hash check, extract with system tar into `DATA_DIR/runtime/b11146-<platform-arch>/`, VERSION stamp, atomic rename; Desktop's KEEP/DROP filters (incl. `ggml-cpu-*` variants).
- Docker: baked in the image; final stage `node:22-trixie-slim` (glibc 2.41) + libgomp1; build fails if `ldd llama-server | grep "not found"`.
- systemd: `scripts/install-linux.sh` runs `twoody-server runtime install`.
- Gate: official arm64 build ≥ 0.9× Ollama speed on the Pi, else our own CI build (ubuntu-24.04-arm, `GGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16`) from the same tag, released by Osmove, hash pinned.

## 2. Shared code: owned by the server, reused by the Desktop
New `src/builtin/`: `catalog.ts` (← Desktop modelCatalog.ts), `downloads.ts` (← modelDownloads.ts),
`acceleration.ts` (← runtimeAcceleration.ts), `failure.ts` (← runtimeFailure.ts),
`manager.ts` (← builtinRuntime.ts as `createRuntimeManager({binaryDir, modelsDir, stateDir, log, env})`, no Electron),
`runtimeManifest.ts`, `fetchRuntime.ts`, `engine.ts`, `prefs.ts`, `index.ts` (export `"./builtin"`).
Desktop: builtinRuntime.ts becomes a thin Electron adapter; the four modules become re-exports via alias
`@twoody/builtin` → `../twoody-server/src/builtin` (bundle-server.mjs already builds from that checkout).
One process manager only: the Desktop starts its embedded server with `TWOODY_RUNTIME_OWNER=desktop`
(the server never spawns llama-server then; install routes answer `409 managed_by_desktop`).

## 3. Headless process management
Router mode like the Desktop: `--host 127.0.0.1`, ports from 47831, `--models-dir DATA_DIR/models`,
`--models-max 1`, `--offline`, `--no-webui`, `--cors-origins http://twoody.invalid`, `--parallel 1`;
minimal env (PATH, HOME, TMPDIR, per-launch `LLAMA_API_KEY`); `runtime.pid`, and a leftover llama-server is
stopped only if its command line has our models dir.
- Started on demand (`manager.ensure()` on a chat to the built-in engine); status/heartbeat never start it.
- Idle unload `--sleep-idle-seconds` 30 min default.
- Memory check: MemAvailable ≥ size × 1.15 + KV, else `507 insufficient_memory`.
- Pi defaults: threads = cores (4), `--ctx-size 8192` on ARM Linux, Desktop's builtinContextSize() elsewhere, mmap on.
- `addRuntimeKey(baseUrl, key)` in src/runtimeAuth.ts. SIGTERM/SIGINT stop the runtime; unit `KillMode=control-group`,
  `TimeoutStopSec=10`; compose `init: true`; crash restart ≤ 3 with backoff.

## 4. « Moteur »
`DATA_DIR/runtime.json` (0600), per computer, overridable by `TWOODY_RUNTIME`, re-read on mtime change:
`{engine:"auto"|"builtin"|"ollama"|"lmstudio"|"mlx"|"custom", custom_url?, builtin:{default_model?, idle_minutes?, preload?, ctx?, threads?}}` (`idle_minutes` 0: never
released; unset: kept while the server runs when MemAvailable holds the model twice over, else 30;
`preload` false: no model loaded at startup; files carry `"v": 2`, and an older file's `idle_minutes: 30` is read as unset).
Auto = first engine with a chat model: builtin → Ollama :11434 (or TWOODY_OLLAMA_URL) → LM Studio :1234 → mlx-lm :8080 (macOS).
`engine.ts` exports `resolveEngine() → {id, baseUrl, models, reason}`.
Routes `src/routes/runtime.ts` (owner session only, peers 403):
- `GET /runtime` → `{preference, active:{id, reason}, engines:[{id,name,reachable,models}], builtin:{installed, version, platform, acceleration, running, loaded_model, failure, managed_by}}`
- `PUT /runtime {engine, custom_url?}`
- `GET /runtime/catalog` (installed, recommended, fits)
- `POST /runtime/models {id}` → `202 {job}` (states runtime → downloading → verifying → done); `GET|DELETE /runtime/jobs/current`
- `DELETE /runtime/models/:id`
`/local_llm/*` stays for Ollama. Downloads the person asked for are allowed under TWOODY_LOCAL_ONLY (allowlisted hosts, logged).
Surfacing: non-stored provider `{id:"engine", kind:"local_openai", name:"Twoody (llama.cpp)", models}` in /providers
(queries.ts resolves "engine"); statusSource.localRuntimes() active engine first; loadedModels() asks the manager;
`ComputerStatus.engine?`; router defaultModel() falls back to builtin.default_model.
UI: Desktop `EngineSettings.tsx` in PrivateSettings (this Mac), `ModelsPanel.tsx` on /runtime (replaces Ollama-only
« Twoody Pi »), opened per computer from ComputersPanel; iPhone « Moteur » row + « Modèles » per computer through its
computerKey route; CLI `twoody-server config get|set runtime=…`, `runtime install|status`, `models list|add|rm`.

## 5. Migration
No runtime.json on first start: BRIDGE_LOCAL_LLM_ENDPOINT on :11434 → `ollama` (Jimmy's Pi unchanged), elsewhere → `custom`,
unset → `auto`. Switch: `config set runtime=builtin`, `models add Qwen3.5-4B-Q4_K_M`; default model reset; the apps offer
(never automatically) to remove Ollama models. Compose: one container by default, `ollama` under `profiles: ["ollama"]`
with `TWOODY_OLLAMA_URL`. README Pi section on built-in, Ollama for NVIDIA.

## 6. Tests
Manifest digests/tag parity; fetch against a local mirror (bad hash, off-allowlist redirect, atomic install); ported
download tests; resolveEngine table; manager with a fake llama-server script (flags, loopback, key, idle, leftovers,
memory refusal); routes (auth, peers, 409 in Desktop); status/rank see built-in models; CI smoke with a tiny GGUF
(TWOODY_MODEL_CATALOG). Pi: separate install in ~/twoody-next on port 3031, never touching HA, firmware services,
the old server on 3030 or the Ollama service; speed gate vs Ollama with nothing loaded; think off, 401 without key,
127.0.0.1 only, idle unload, leftover stop after kill -9.

## 7. Lots
A server core (src/builtin/* only, now) · B server integration (after multi-computer) · C packaging (with B) ·
D Desktop (after A) · E iPhone (after B's API) · F CLI (after B).
Risks: glibc / missing dotprod variant, SD card speed, backend heartbeat validation of `engine`, engine-specific model
names, two managers in the Desktop, local-only wording, Pi heat, supply chain (hashes pinned), LICENSE.llama.cpp shipped.
