// Twoody's app at Google (« Se connecter avec Google », Capacités →
// E-mails): a client of the « Desktop app » kind. Google gives such a client
// a secret too, and says it is not one — it ships inside every copy of the
// app, as the client's id does — so it is sent with every renewal of the
// sign-in, as Google asks. Not registered yet: until both are known, no
// mailbox signs in with Google (the Desktop hides its button). The Desktop's
// main process hands its own to this server (twoody-desktop
// src/main/googleClient.ts, TWOODY_GOOGLE_CLIENT_ID / _SECRET), which wins
// over the ones written here.

export const GOOGLE_CLIENT_ID = "";
export const GOOGLE_CLIENT_SECRET = "";

/// The client this server renews Google's sign-in with, or null while
/// there is none.
export function googleClient(): { id: string; secret: string } | null {
  const id = process.env.TWOODY_GOOGLE_CLIENT_ID?.trim() || GOOGLE_CLIENT_ID;
  const secret = process.env.TWOODY_GOOGLE_CLIENT_SECRET?.trim() || GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret } : null;
}
