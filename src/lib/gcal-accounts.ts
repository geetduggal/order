// Thin bridge to the Rust gcal account commands (desktop OAuth, Plan 2).
import { invoke } from "@tauri-apps/api/core";

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
