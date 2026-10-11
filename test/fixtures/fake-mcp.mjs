// A tiny MCP server over stdio for the tests of « Connecteurs »: one tool,
// `lookup`, that answers with the word it was given and the environment's
// GREETING (so that a connector's environment is seen to reach it). It says
// `lookup` only reads and `erase_all` destroys (MCP tool annotations).
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } });
  else if (message.method === "tools/list") send({ id: message.id, result: { tools: [
    { name: "lookup", description: "Finds a word in the notebook", inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] }, annotations: { readOnlyHint: true } },
    { name: "erase_all", description: "Erases the notebook", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } },
    // EXTRA_TOOLS=n: a server with many tools, as J-Way's 58.
    ...Array.from({ length: Number(process.env.EXTRA_TOOLS ?? 0) }, (_, i) => ({ name: `extra_${i}`, description: `Extra tool ${i}`, inputSchema: { type: "object", properties: {} } })),
  ] } });
  else if (message.method === "tools/call") send({ id: message.id, result: { content: [{ type: "text", text: `${process.env.GREETING ?? "?"}: ${message.params.arguments.word} found on page 12` }] } });
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "unknown" } });
});
