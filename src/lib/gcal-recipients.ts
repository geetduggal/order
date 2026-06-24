// Pure host/invitee resolution for Google Calendar sync. Given the emails
// written on an event line, the user's connected (authenticated) accounts, and
// their default account, decide which calendar HOSTS the event and who is
// INVITED. Dependency-free so it can be unit-tested in isolation.
export interface ResolvedRecipients {
  /** The account whose calendar hosts the event, or null when it can't be
   *  determined (no emails, or no connected match and no default set). */
  host: string | null;
  /** Emails to invite as attendees (never includes a connected account). */
  invitees: string[];
}

export function resolveRecipients(
  emails: string[],
  connectedAccounts: string[],
  defaultAccount: string | null,
): ResolvedRecipients {
  const norm = (e: string) => e.trim().toLowerCase();
  const list = emails.map(norm).filter((e) => e.length > 0);
  if (list.length === 0) return { host: null, invitees: [] };

  const connected = new Set(connectedAccounts.map(norm));
  const onLineConnected = list.filter((e) => connected.has(e));
  const invitees = list.filter((e) => !connected.has(e));

  if (onLineConnected.length > 0) {
    return { host: onLineConnected[0], invitees };
  }
  return { host: defaultAccount ? norm(defaultAccount) : null, invitees };
}
