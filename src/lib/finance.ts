// Thin TS bridge to the Finance CORE (src-tauri/src/finance.rs). Per the OSuite
// principles, the Rust commands are the API; this module (and the UI on top of it)
// is just one client. A CLI or voice-agent would call the same commands.

import { invoke } from "@tauri-apps/api/core";

export interface Txn {
  date: string;
  merchant: string;
  amount: number;
  account: string;
  balance: number | null;
  plaid_transaction_id: string;
  category: string;
}

export interface CredsStatus {
  configured: boolean;
  env: string;
  accounts: string[];
}

export interface MerchantTotal { merchant: string; account: string; total: number; count: number; }
export interface Anomaly { merchant: string; account: string; current: number; trailing_avg: number; ratio: number; is_new: boolean; }
export interface Recurring { merchant: string; account: string; months: number; avg_amount: number; is_new: boolean; }
export interface Provenance {
  generated_at: string; script_version: string; period_start: string; period_end: string;
  accounts: string[]; fetched_start: string; fetched_end: string; row_count: number;
}
export interface ReportData {
  by_merchant: MerchantTotal[]; total_spend: number; anomalies: Anomaly[]; recurring: Recurring[]; provenance: Provenance;
}
export interface ReportResult { csv_path: string; html_path: string; data: ReportData; }

/** Save Plaid credentials (stored outside the vault, in the app config dir). */
export function setPlaidCreds(clientId: string, secret: string, env: string): Promise<void> {
  return invoke("finance_set_creds", { clientId, secret, env });
}

export function credsStatus(): Promise<CredsStatus> {
  return invoke<CredsStatus>("finance_creds_status");
}

export function listAccounts(): Promise<string[]> {
  return invoke<string[]>("finance_accounts");
}

/** Link a bank account: opens Plaid Hosted Link in the browser and blocks until
 *  you finish, then stores the account under `name`. Resolves with the name. */
export function connectAccount(name: string): Promise<string> {
  return invoke<string>("finance_connect", { name });
}

export function disconnectAccount(name: string): Promise<void> {
  return invoke("finance_disconnect", { name });
}

/** Ad-hoc fetch (e.g. a voice "pull my last month of transactions"). */
export function fetchTransactions(accounts: string[], start: string, end: string): Promise<Txn[]> {
  return invoke<Txn[]>("finance_fetch", { accounts, start, end });
}

/** Generate a report: fetch fresh from Plaid for [start,end] (plus trailing
 *  baseline), write a snapshot CSV + HTML report into `dirRel` (a vault-relative
 *  folder), and return the paths + computed data. */
export function generateReport(accounts: string[], start: string, end: string, dirRel: string): Promise<ReportResult> {
  return invoke<ReportResult>("finance_report", { accounts, start, end, dirRel });
}

/** Regenerate a report from an existing snapshot CSV (no Plaid). */
export function reportFromCsv(csvRel: string, start: string, end: string, accounts: string[]): Promise<ReportResult> {
  return invoke<ReportResult>("finance_report_from_csv", { csvRel, start, end, accounts });
}
