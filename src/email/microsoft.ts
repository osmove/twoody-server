import { MailDoorClosedError } from "../outbound.js";
import { microsoftAccess as accessFor, MicrosoftSignInError, type MicrosoftAccess } from "../microsoft/token.js";
import { MailError } from "./imap.js";

// « Se connecter avec Microsoft » (Capacités → E-mails, 04/10/2026): an
// Outlook.com or Microsoft 365 mailbox takes no password over IMAP, only
// Microsoft's own sign-in (OAuth 2.0). It is linked with that sign-in and
// read over IMAP with XOAUTH2.
//
// The sign-in itself runs in the Desktop's main process (twoody-desktop
// src/main/microsoftSignIn.ts: the browser, PKCE, a loopback redirect),
// which hands this server the refresh token and nothing else; it is kept
// as a password is (credentials.ts). Before each session on the mailbox,
// an access token to IMAP is got with it (src/microsoft/token.ts, shared
// with the link to Outlook's calendar and contacts): from memory, or at
// Microsoft's token endpoint — the one address the door of src/outbound.ts
// opens for it, while E-mails is on and the mailbox is a Microsoft one.
// What goes wrong is said as the mailbox's codes (imap.ts MailErrorCode).

export { forgetMicrosoftAccess, MICROSOFT_CLIENT_ID, microsoftErrorCode, useMicrosoftTokenEndpointForTests, type MicrosoftAccess } from "../microsoft/token.js";

/// Outlook.com and Microsoft 365 mailboxes alike.
export const MICROSOFT_IMAP = { host: "outlook.office365.com", port: 993, security: "tls" } as const;
const IMAP_SCOPE = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";

/// An access token to the mailbox (IMAP) with this sign-in: from memory
/// until shortly before it expires — unless `fresh`, the server having
/// refused it — else from Microsoft, through the door. `microsoftMailbox`:
/// the mailbox set up, or being set up, signs in with Microsoft.
export async function microsoftAccess(refreshToken: string, door: { microsoftMailbox: boolean; emailOn: boolean }, options: { fresh?: boolean } = {}): Promise<MicrosoftAccess> {
  try {
    return await accessFor(refreshToken, { scope: IMAP_SCOPE, door }, options);
  } catch (err) {
    if (err instanceof MicrosoftSignInError) throw new MailError(err.code);
    if (err instanceof MailDoorClosedError) throw new MailError(err.reason);
    throw err;
  }
}
