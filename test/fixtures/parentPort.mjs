// Stands in for Electron's `process.parentPort` when this server runs as
// a plain Node child with an IPC channel: the same two calls Twoody
// Desktop's utility process offers, carried over `process.send`. Loaded
// with `--import` before src/index.ts, so the server finds it where it
// would find Electron's.
if (typeof process.send === "function") {
  process.parentPort = {
    on(event, listener) {
      if (event === "message") process.on("message", (data) => listener({ data }));
    },
    postMessage(message) {
      process.send(message);
    },
  };
}
