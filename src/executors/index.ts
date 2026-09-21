// In-process bridge executor.
//
// When `TWOODY_SELF_BRIDGE=1` the server runs the bridge task kinds
// itself instead of waiting for an external Mac worker to long-poll
// `/bridge/tasks/next`. This is the only way to run twoody-server on
// headless Linux without a separate worker daemon.
//
// Supported here: `search`, `read`, `list_folders`, `list_dir`,
// `llm_infer`. The macOS-specific kinds (`thumbnail`, `photos_*`,
// `app_open`, `shortcut_*`, `ocr_image`, `open_document`) stay
// queue-only — they have no Linux equivalent.

import { runListDir } from "./listDir.js";
import { runListFolders } from "./listFolders.js";
import { runLlmInfer, type LlmInferHooks } from "./llmInfer.js";
import { runOcr, tesseractReady } from "./ocr.js";
import { runRead } from "./read.js";
import { runSearch } from "./search.js";
import { runTranscribe, whisperReady } from "./transcribe.js";

export const SELF_BRIDGE_KINDS = [
  "search",
  "read",
  "list_folders",
  "list_dir",
  "llm_infer",
  "transcribe",
  "ocr_image",
] as const;

export type SelfBridgeKind = (typeof SELF_BRIDGE_KINDS)[number];

export function isSelfBridgeKind(value: string): value is SelfBridgeKind {
  return (SELF_BRIDGE_KINDS as readonly string[]).includes(value);
}

export function selfBridgeEnabled(): boolean {
  return process.env.TWOODY_SELF_BRIDGE === "1";
}

export async function executeBridgeTask(
  kind: SelfBridgeKind,
  args: Record<string, unknown>,
  hooks: LlmInferHooks = {},
): Promise<unknown> {
  switch (kind) {
    case "search":
      return runSearch(args);
    case "read":
      return runRead(args);
    case "list_folders":
      return runListFolders();
    case "list_dir":
      return runListDir(args);
    case "llm_infer":
      return runLlmInfer(args, hooks);
    case "transcribe":
      return runTranscribe(args);
    case "ocr_image":
      return runOcr(args);
  }
}

export { whisperReady, tesseractReady };
