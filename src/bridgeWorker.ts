// Standalone Bridge worker: lends this machine's local models to a
// Twoody account hosted elsewhere (api.twoody.com or a self-hosted
// backend), and nothing more. No HTTP server is opened and no database
// is created — the process only makes outgoing requests: long polls to
// the backend, completions to the local runtimes.
//
// It is what the desktop app runs when the user is signed in to a cloud
// account and picks one of the models installed on the computer.
//
// Two ways to configure it:
//   - the environment, like the full server (TWOODY_BACKEND_URL,
//     TWOODY_USER_TOKEN, TWOODY_DEVICE_TOKEN, BRIDGE_LOCAL_LLM_ENDPOINTS,
//     BRIDGE_LOCAL_LLM_MODEL, TWOODY_BRIDGE_DEVICE_NICKNAME);
//   - a `configure` message from the parent process, when started by
//     Electron's utilityProcess. The account token then never appears in
//     the process environment, which other processes of the same user
//     can read.

import { readBridgeClientEnv, startBridgeClient, type BridgeClientHandle, type BridgeClientState } from "./bridgeClient.js";
import { configureLocalModels } from "./executors/localModels.js";

interface ConfigureMessage {
  type: "configure";
  backendUrl: string;
  userToken: string;
  deviceToken?: string;
  deviceNickname?: string;
  deviceIdPath?: string;
  endpoints?: string[];
  defaultModel?: string | null;
}

interface ModelsMessage {
  type: "models";
  endpoints?: string[];
  defaultModel?: string | null;
}

type ParentMessage = ConfigureMessage | ModelsMessage | { type: "stop" };

interface ParentPort {
  on(event: "message", listener: (event: { data: ParentMessage }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
let client: BridgeClientHandle | null = null;

function start(options: Omit<ConfigureMessage, "type" | "endpoints" | "defaultModel">) {
  client?.stop();
  client = startBridgeClient({
    backendUrl: options.backendUrl.replace(/\/+$/, ""),
    userToken: options.userToken,
    deviceToken: options.deviceToken,
    homeAssistantUrl: "",
    homeAssistantToken: "",
    deviceNickname: options.deviceNickname,
    deviceIdPath: options.deviceIdPath,
    capabilities: ["local-llm-provider"],
    onState: (state: BridgeClientState) => {
      console.log(`[bridge-worker] ${state}`);
      parentPort?.postMessage({ type: "state", state, deviceId: client?.deviceId ?? null });
    },
  });
  console.log(`[bridge-worker] serving local models to ${options.backendUrl} (device ${client.deviceId.slice(0, 8)}…)`);
}

if (parentPort) {
  parentPort.on("message", ({ data }) => {
    if (data.type === "configure") {
      configureLocalModels({ endpoints: data.endpoints, defaultModel: data.defaultModel });
      start(data);
    } else if (data.type === "models") {
      configureLocalModels({ endpoints: data.endpoints, defaultModel: data.defaultModel });
    } else if (data.type === "stop") {
      client?.stop();
      process.exit(0);
    }
  });
  parentPort.postMessage({ type: "ready" });
} else {
  const env = readBridgeClientEnv();
  if (!env) {
    console.error("[bridge-worker] TWOODY_BACKEND_URL and TWOODY_USER_TOKEN are required");
    process.exit(1);
  }
  start(env);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    client?.stop();
    process.exit(0);
  });
}
