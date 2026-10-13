/// Node 22's test runner cancels a test whose promise is still pending once
/// the event loop has nothing else to run (« Promise resolution is still
/// pending but the event loop has already resolved »), and every test after
/// it in the file. Code that waits on an unref'd timer or worker on purpose
/// (so a pending request never holds a server's exit) then looks hung,
/// although it would finish. This keeps the loop open while `pending` runs.
/// (Node 24 happens to keep it open on its own: the tests passed there.)
export async function heldOpen<T>(pending: Promise<T>): Promise<T> {
  const hold = setInterval(() => undefined, 60_000);
  try {
    return await pending;
  } finally {
    clearInterval(hold);
  }
}
