// Thin bridge to the Rust gcal account commands (desktop OAuth, Plan 2).
import { invoke } from "@tauri-apps/api/core";
import type { ImportedEvent } from "./gcal-import";

export interface AccountsView {
  accounts: string[];
  default: string | null;
  has_credentials: boolean;
  client_id: string;
}

export const listAccounts = () => invoke<AccountsView>("gcal_list_accounts");
export const connectAccount = () => invoke<string>("gcal_connect_account");
export const setDefault = (email: string) => invoke<void>("gcal_set_default", { email });
export const disconnect = (email: string) => invoke<void>("gcal_disconnect", { email });
export const setCredentials = (clientId: string, clientSecret: string) =>
  invoke<void>("gcal_set_credentials", { clientId, clientSecret });

export interface PushEventInput {
  host: string;
  date: string;
  time?: string;
  endTime?: string;
  allDay: boolean;
  title: string;
  description: string;
  attendees: string[];
}

export const pushEvent = (input: PushEventInput) => invoke<string>("gcal_push_event", { input });

export const listDayEvents = (account: string, date: string) =>
  invoke<ImportedEvent[]>("gcal_list_day_events", { account, date });
