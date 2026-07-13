// Pure computation of Google Calendar push intents from spacetime events.
// One intent per Google-synced event (carries emails AND resolves to a host
// account). The natural-key create-vs-update decision is made server-side in
// the gcal_push_event command, so this only resolves scheduling + recipients.
import type { SpacetimeEvent } from "./spacetime";
import { resolveRecipients } from "./gcal-recipients";

export interface PushIntent {
  host: string;
  date: string;
  time?: string;
  endTime?: string;
  /** Inclusive last day of a multi-day span (absent for single-day events). */
  endDate?: string;
  allDay: boolean;
  title: string;
  attendees: string[];
  /** Content hash of the event's backing-note description (see
   *  descriptionHash), if a backing note exists. Folded into the push
   *  signature so a real description edit re-flags the event — but an
   *  mtime-only touch (Dropbox re-download, a content-neutral self-write)
   *  does NOT, which is what made events resync when nothing changed.
   *  Enriched by the caller (CardGrid); buildPushIntents has no note access. */
  descHash?: string;
}

/** The exact text Order pushes as an event's Google Calendar description:
 *  the backing note's file content with the YAML frontmatter stripped, then
 *  trimmed. Centralized so the pending-sync signature and the real push
 *  (applyGcalSync) derive the description identically. */
export function eventDescriptionFromRaw(raw: string): string {
  return raw.replace(/^---[\s\S]*?---\n?/, "").trim();
}

/** Compact, stable hash of a description string (FNV-1a, base36). Used only
 *  to detect description changes for the push signature — not cryptographic.
 *  Stable across runs/devices for identical content, so it never churns the
 *  way a filesystem mtime does. */
export function descriptionHash(desc: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < desc.length; i++) {
    h ^= desc.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function buildPushIntents(
  events: SpacetimeEvent[],
  connectedAccounts: string[],
  defaultAccount: string | null,
): PushIntent[] {
  const out: PushIntent[] = [];
  for (const ev of events) {
    if (!ev.emails || ev.emails.length === 0) continue;
    const { host, invitees } = resolveRecipients(ev.emails, connectedAccounts, defaultAccount);
    if (!host) continue;
    out.push({
      host,
      date: ev.date,
      ...(ev.time ? { time: ev.time } : {}),
      ...(ev.endTime ? { endTime: ev.endTime } : {}),
      ...(ev.endDate ? { endDate: ev.endDate } : {}),
      allDay: ev.allDay === true || !ev.time,
      title: ev.title,
      attendees: invitees,
    });
  }
  return out;
}
