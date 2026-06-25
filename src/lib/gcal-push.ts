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
