// Settings panel — opened from the gear icon in the bottom-left.
// Currently just the vault location: shows the active path and lets
// the user pick a different folder (native dialog) or reset to the
// default. The parent persists the choice and reloads the vault.

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X as XIcon, Folder as FolderIcon, Info as InfoIcon } from "lucide-react";
import { vaultRoot, defaultVaultRoot, getVaultOverride, isIos, isIosSync } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";
import { getOpenaiKey, setOpenaiKey, getElevenKey, setElevenKey, getElevenSelected, setElevenSelected, listElevenVoices, OPENAI_VOICES, getOpenaiSelected, setOpenaiSelected, getUnrealKey, setUnrealKey, getUnrealSelected, setUnrealSelected, UNREAL_VOICES, getAudioOutput, setAudioOutput, type AudioOutput } from "../lib/tts";
import {
  getAgentProvider, setAgentProvider,
  getAgentKeyFor, setAgentKeyFor,
  getAgentModelFor, setAgentModelFor,
  getAgentBaseUrlFor, setAgentBaseUrlFor,
  AGENT_DEFAULT_MODEL, type AgentProvider,
} from "../lib/agent";
import { getSttEngine, setSttEngine, type SttEngine } from "../lib/voice";
import { costBreakdown, formatUSD, resetUsage, USAGE_EVENT } from "../lib/usage";
// Pure localStorage helper — static-imported so the checkbox toggle is
// SYNCHRONOUS (a dynamic import defers setState a tick, and the controlled
// checkbox reverts in between, so the box won't tick).
import { toggleIncludedCalendar as toggleAppleCalendar } from "../lib/apple-cal";
import { getRemindersDefault, setRemindersDefault } from "../lib/apple-reminder";
import * as finance from "../lib/finance";

export function SettingsPanel({
  onChangeVault, onClose,
  johnnyDecimal, johnnyDecimalBusy, onToggleJohnnyDecimal, onAssignMissingJdIds,
  frontierFolder, onSetFrontierFolder, folderOptions,
  badgeEnabled, badgeCount, onToggleBadge,
}: {
  onChangeVault: (path: string | null) => Promise<void>;
  onClose: () => void;
  johnnyDecimal: boolean;
  johnnyDecimalBusy: boolean;
  onToggleJohnnyDecimal: (enable: boolean) => Promise<void>;
  onAssignMissingJdIds: () => Promise<void>;
  frontierFolder: string;
  onSetFrontierFolder: (ref: string) => void;
  folderOptions: string[];
  badgeEnabled: boolean;
  badgeCount: number;
  onToggleBadge: (on: boolean) => Promise<void>;
}) {
  const [current, setCurrent] = useState<string>("");
  const [fallback, setFallback] = useState<string>("");
  const [overridden, setOverridden] = useState<boolean>(getVaultOverride() !== null);
  const [busy, setBusy] = useState(false);

  // Cloud text-to-speech API keys (optional premium voices).
  const [openaiKey, setOpenaiKeyState] = useState<string>(() => getOpenaiKey());
  const [elevenKey, setElevenKeyState] = useState<string>(() => getElevenKey());
  const [agentProvider, setAgentProviderState] = useState<AgentProvider>(() => getAgentProvider());
  const [agentKeyVal, setAgentKeyVal] = useState<string>(() => getAgentKeyFor(getAgentProvider()));
  const [agentModelVal, setAgentModelVal] = useState<string>(() => getAgentModelFor(getAgentProvider()));
  const [agentBaseVal, setAgentBaseVal] = useState<string>(() => getAgentBaseUrlFor(getAgentProvider()));
  const switchAgentProvider = (p: AgentProvider) => {
    setAgentProviderState(p); setAgentProvider(p);
    setAgentKeyVal(getAgentKeyFor(p)); setAgentModelVal(getAgentModelFor(p)); setAgentBaseVal(getAgentBaseUrlFor(p));
  };
  const [sttEngine, setSttEngineState] = useState<SttEngine>(() => getSttEngine());
  const [audioOut, setAudioOutState] = useState<AudioOutput>(() => getAudioOutput());
  // Re-render the usage meter whenever a chat/dictation/read-aloud is recorded.
  const [, setUsageTick] = useState(0);
  useEffect(() => {
    const bump = () => setUsageTick((n) => n + 1);
    window.addEventListener(USAGE_EVENT, bump);
    return () => window.removeEventListener(USAGE_EVENT, bump);
  }, []);
  const usage = costBreakdown();
  // Group the settings into a few tabs so the panel never becomes a long scroll.
  // Rows carry a data-group; the active tab hides the rest (see settings CSS).
  type SettingsTab = "vault" | "calendar" | "voice" | "finance" | "usage";
  // Lock the background scroll while Settings is open so the panel's own scroll
  // doesn't compete with the page behind it.
  useEffect(() => {
    document.body.classList.add("settings-open");
    return () => document.body.classList.remove("settings-open");
  }, []);
  const [tab, setTab] = useState<SettingsTab>("vault");
  const TABS: { key: SettingsTab; label: string }[] = [
    { key: "vault", label: "Vault" },
    { key: "calendar", label: "Calendar" },
    { key: "voice", label: "Voice & Agent" },
    { key: "finance", label: "Finance" },
    { key: "usage", label: "Usage" },
  ];
  const [elevenVoices, setElevenVoices] = useState<{ id: string; name: string }[]>([]);
  const [elevenSel, setElevenSel] = useState<string[]>(() => getElevenSelected());
  // Load the user's ElevenLabs voices for the picker whenever a key is present.
  useEffect(() => {
    if (!elevenKey.trim()) { setElevenVoices([]); return; }
    let cancelled = false;
    void listElevenVoices().then((vs) => { if (!cancelled) setElevenVoices(vs); });
    return () => { cancelled = true; };
  }, [elevenKey]);
  const toggleElevenVoice = (id: string) => {
    const next = elevenSel.includes(id) ? elevenSel.filter((x) => x !== id) : [...elevenSel, id];
    setElevenSel(next);
    setElevenSelected(next);
  };
  const [openaiSel, setOpenaiSel] = useState<string[]>(() => getOpenaiSelected());
  const toggleOpenaiVoice = (id: string) => {
    const next = openaiSel.includes(id) ? openaiSel.filter((x) => x !== id) : [...openaiSel, id];
    setOpenaiSel(next);
    setOpenaiSelected(next);
  };
  const [unrealKey, setUnrealKeyState] = useState<string>(() => getUnrealKey());
  const [unrealSel, setUnrealSel] = useState<string[]>(() => getUnrealSelected());
  const toggleUnrealVoice = (id: string) => {
    const next = unrealSel.includes(id) ? unrealSel.filter((x) => x !== id) : [...unrealSel, id];
    setUnrealSel(next);
    setUnrealSelected(next);
  };

  const [gcal, setGcal] = useState<import("../lib/gcal-accounts").AccountsView>({ accounts: [], default: null, has_credentials: false, client_id: "", client_id_ios: "" });
  const [gcalId, setGcalId] = useState("");
  const [gcalSecret, setGcalSecret] = useState("");
  const [gcalBusy, setGcalBusy] = useState(false);
  const [gcalError, setGcalError] = useState<string | null>(null);
  const [gcalHelpOpen, setGcalHelpOpen] = useState(false);

  // ---- Finance (OSuite Finance MVP) — SETUP ONLY here (keys + linked accounts).
  // Report generation is launched from a notable folder's ⋯ menu (the $ item),
  // where date range + account subset are chosen.
  const [finStatus, setFinStatus] = useState<finance.CredsStatus>({ configured: false, env: "sandbox", accounts: [] });
  const [finId, setFinId] = useState("");
  const [finSecret, setFinSecret] = useState("");
  const [finEnv, setFinEnv] = useState("sandbox");
  const [finNewAccount, setFinNewAccount] = useState("");
  const [finBusy, setFinBusy] = useState(false);
  const [finError, setFinError] = useState<string | null>(null);
  const refreshFinance = useCallback(async () => {
    try { const s = await finance.credsStatus(); setFinStatus(s); setFinEnv((e) => e || s.env); }
    catch (e) { setFinError(String(e)); }
  }, []);
  useEffect(() => { if (tab === "finance") void refreshFinance(); }, [tab, refreshFinance]);
  const refreshGcal = useCallback(async () => {
    // Keep the default view if the backend returns nothing — otherwise a null
    // response nulls out `gcal` and every `gcal.client_id` read below throws.
    try { const v = await import("../lib/gcal-accounts").then((m) => m.listAccounts()); if (v) setGcal(v); }
    catch (e) { setGcalError(String(e)); }
    // Notify the calendar shell so its Google-sync pending list recomputes.
    window.dispatchEvent(new Event("order:gcal-accounts-changed"));
  }, []);
  useEffect(() => { void refreshGcal(); }, [refreshGcal]);
  // Reflect the saved (non-secret) client ID back into the field so the
  // panel shows what's stored after reopening — the inputs are otherwise
  // ephemeral component state and look empty even when creds are saved.
  useEffect(() => {
    if (gcal.client_id && !gcalId) setGcalId(gcal.client_id);
  }, [gcal.client_id, gcalId]);
  const [iosId, setIosId] = useState("");
  useEffect(() => { if (gcal.client_id_ios && !iosId) setIosId(gcal.client_id_ios); }, [gcal.client_id_ios, iosId]);

  // ---- Apple / system calendar (EventKit) ----
  const [appleStatus, setAppleStatus] = useState<string>("");
  const [appleCals, setAppleCals] = useState<import("../lib/apple-cal").CalendarInfo[]>([]);
  const [appleIncluded, setAppleIncluded] = useState<string[]>([]);
  const [appleBusy, setAppleBusy] = useState(false);
  const [appleErr, setAppleErr] = useState<string | null>(null);
  const refreshApple = useCallback(async () => {
    try {
      const m = await import("../lib/apple-cal");
      const status = await m.accessStatus();
      setAppleStatus(status);
      setAppleIncluded(m.getIncludedCalendarIds());
      // Always TRY to list calendars, not only when the status string is
      // exactly "authorized" — some macOS versions report a status we don't map
      // cleanly but still allow reads. If any come back, we show them.
      try { setAppleCals(await m.listCalendars()); }
      catch { setAppleCals([]); }
    } catch (e) { setAppleErr(String(e)); }
  }, []);
  useEffect(() => { void refreshApple(); }, [refreshApple]);

  // System Reminders (EventKit) — permission + status, mirrors Apple Calendar.
  const [reminderStatus, setReminderStatus] = useState<string>("");
  const [remindDefault, setRemindDefault] = useState<boolean>(() => getRemindersDefault());
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderErr, setReminderErr] = useState<string | null>(null);
  const refreshReminder = useCallback(async () => {
    try { const m = await import("../lib/apple-reminder"); setReminderStatus(await m.accessStatus()); }
    catch (e) { setReminderErr(String(e)); }
  }, []);
  useEffect(() => { void refreshReminder(); }, [refreshReminder]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [cur, def] = await Promise.all([vaultRoot(), defaultVaultRoot()]);
      if (cancelled) return;
      setCurrent(cur);
      setFallback(def);
      setOverridden(getVaultOverride() !== null);
    })();
    return () => { cancelled = true; };
  }, []);

  const choose = async () => {
    setBusy(true);
    try {
      let picked: string | null = null;
      // iOS: Tauri's dialog plugin can't open a directory picker, so
      // the desktop `open({ directory: true })` call returns null and
      // the Change button looks broken. Route through the vault
      // plugin's iOS bridge instead — it pops a native
      // UIDocumentPickerViewController in folder-pick mode and stashes
      // a security-scoped bookmark for the chosen folder.
      if (await isIos()) {
        try {
          const v = await vaultFs.pickFolder();
          picked = v?.path ?? null;
        } catch (err) {
          console.error("iOS pick failed:", err);
        }
      } else {
        const result = await open({
          directory: true,
          multiple: false,
          defaultPath: current || undefined,
        });
        if (typeof result === "string") picked = result;
      }
      if (picked) {
        await onChangeVault(picked);
        setCurrent(picked);
        setOverridden(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await onChangeVault(null);
      setCurrent(fallback);
      setOverridden(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-overlay" role="dialog" aria-label="Settings" onMouseDown={onClose}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2 className="settings-title">Settings</h2>
          <button type="button" className="settings-close" onClick={onClose} aria-label="Close">
            <XIcon size={14} strokeWidth={2.2} />
          </button>
        </div>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              className={"settings-tab" + (tab === t.key ? " is-active" : "")}
              onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        <div className="settings-content" data-tab={tab}>
        <div className="settings-row" data-group="vault">
          <span className="settings-label">Vault folder</span>
          <span className="settings-value" title={current}>
            <FolderIcon size={12} strokeWidth={2} />
            {current}
            {!overridden && <span className="settings-tag">default</span>}
          </span>
          <div className="settings-actions">
            <button type="button" className="settings-btn" onClick={choose} disabled={busy}>
              Change…
            </button>
            {overridden && (
              <button type="button" className="settings-btn settings-btn-quiet" onClick={reset} disabled={busy}>
                Use default
              </button>
            )}
          </div>
          <span className="settings-hint">
            Order reads and writes notes here. Pick a different folder when this
            machine's vault lives elsewhere — the choice is saved on this machine
            only.
          </span>
        </div>

        <div className="settings-row" data-group="vault">
          <span className="settings-label">Johnny-Decimal Mode</span>
          <span className="settings-value">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={johnnyDecimal}
                disabled={johnnyDecimalBusy}
                onChange={(e) => { void onToggleJohnnyDecimal(e.target.checked); }}
              />
              <span>Prefix Areas, Categories & Notable Folders with Johnny.Decimal ids</span>
            </label>
            {johnnyDecimal && (
              <button
                type="button"
                className="settings-btn"
                disabled={johnnyDecimalBusy}
                onClick={() => { void onAssignMissingJdIds(); }}
                title="Give any Notable Folder that currently lacks an id the next free id in its category — without renumbering the folders that already have one."
              >
                Assign missing IDs
              </button>
            )}
          </span>
          <span className="settings-hint">
            {johnnyDecimalBusy
              ? "Renaming folders…"
              : <>Rewrites <code>spacetime.md</code> and renames the matching directories so every
                node carries an id — Areas as ranges (<code>10-19</code>), Categories as numbers
                (<code>11</code>), Notable Folders as <code>11.01</code>. Turning it off strips the
                ids back off. Wikilinks and event tags are updated to match.</>}
          </span>
        </div>

        <div className="settings-row" data-group="calendar">
          <span className="settings-label">Frontier</span>
          <span className="settings-value">
            <input
              // Uncontrolled (keyed to the current setting so external changes
              // reflect) so partial typing shows; commit only a real folder or
              // empty, so a half-typed name never thrashes the setting.
              key={frontierFolder}
              className="settings-input"
              list="settings-week-hub-options"
              placeholder="Notable folder (blank = off)"
              defaultValue={frontierFolder}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === "" || folderOptions.includes(v)) onSetFrontierFolder(v);
              }}
            />
            <datalist id="settings-week-hub-options">
              {folderOptions.map((f) => <option key={f} value={f} />)}
            </datalist>
            {frontierFolder && (
              <button type="button" className="settings-btn" onClick={() => onSetFrontierFolder("")}>Clear</button>
            )}
          </span>
          <span className="settings-hint">
            Pins this folder's Main Document above the <strong>Week</strong> view as an
            editable "one stop shop" — the real editor, saving to the folder's doc like
            anywhere else. Drag the divider to resize (persisted); blank turns it off and
            the week grid fills the screen. New events also default to this folder.
          </span>
        </div>

        <div className="settings-row" data-group="calendar">
          <span className="settings-label">Saturday badge</span>
          <span className="settings-value">
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={badgeEnabled}
                onChange={(e) => { void onToggleBadge(e.target.checked); }}
              />
              <span>Show a count on the app icon{badgeEnabled ? ` — currently ${badgeCount}` : ""}</span>
            </label>
          </span>
          <span className="settings-hint">
            Badges the Order icon with how many events fall on the upcoming (or current)
            {" "}<strong>Saturday</strong> in the Week Hub folder — a quick glance at your
            weekend load. Turning this on asks iOS/macOS for notification permission (that's
            what makes <em>Order</em> appear under Settings → Notifications); grant it, then
            the badge shows.{!frontierFolder && <> Set a <strong>Frontier</strong> folder
            above so there's something to count (the count is 0 until then).</>}
          </span>
        </div>

        <div className="settings-row" data-group="finance">
          <span className="settings-label">Plaid keys</span>
          <span className="settings-value">
            <input className="settings-input" placeholder="Client ID" defaultValue={finId} onChange={(e) => setFinId(e.target.value)} />
            <input className="settings-input" type="password" placeholder="Secret" defaultValue={finSecret} onChange={(e) => setFinSecret(e.target.value)} />
            <select className="settings-input" value={finEnv} onChange={(e) => setFinEnv(e.target.value)}>
              <option value="sandbox">Sandbox</option>
              <option value="development">Development</option>
              <option value="production">Production</option>
            </select>
            <button
              type="button"
              className="settings-btn"
              disabled={finBusy}
              onClick={async () => {
                setFinBusy(true); setFinError(null);
                try { await finance.setPlaidCreds(finId.trim(), finSecret.trim(), finEnv); await refreshFinance(); }
                catch (e) { setFinError(String(e)); }
                finally { setFinBusy(false); }
              }}
            >Save</button>
          </span>
          <span className="settings-hint">
            Get free API keys at <strong>dashboard.plaid.com</strong> (Team Settings → Keys):
            your <strong>client_id</strong> and a <strong>secret</strong>. Pick which secret matches
            the environment: <strong>Sandbox</strong> uses fake test banks (no approval needed, great
            to try this out), while <strong>Production</strong> connects your real accounts and needs
            Plaid to grant production access. Keys are stored outside the vault (in the app config
            dir), never in a note. {finStatus.configured ? "Keys are set." : "No keys yet."}
            {finError && <> <span className="settings-error">{finError}</span></>}
          </span>
        </div>

        <div className="settings-row" data-group="finance">
          <span className="settings-label">Linked accounts</span>
          <span className="settings-value">
            <input className="settings-input" placeholder="Name (e.g. Amex)" value={finNewAccount} onChange={(e) => setFinNewAccount(e.target.value)} />
            <button
              type="button"
              className="settings-btn"
              disabled={finBusy || !finNewAccount.trim() || (!finStatus.configured && (!finId.trim() || !finSecret.trim()))}
              title={!finNewAccount.trim() ? "Type an account name first" : (!finStatus.configured && (!finId.trim() || !finSecret.trim()) ? "Enter your Plaid keys above first" : "")}
              onClick={async () => {
                setFinBusy(true); setFinError(null);
                try {
                  // Persist the typed keys first so Connect always uses current creds
                  // (no separate Save step needed for the connect flow).
                  if (finId.trim() && finSecret.trim()) await finance.setPlaidCreds(finId.trim(), finSecret.trim(), finEnv);
                  await finance.connectAccount(finNewAccount.trim());
                  setFinNewAccount(""); await refreshFinance();
                } catch (e) { setFinError(String(e)); }
                finally { setFinBusy(false); }
              }}
            >{finBusy ? "Connecting…" : "Connect bank"}</button>
          </span>
          <span className="settings-hint">
            <strong>1.</strong> Type a label for the account (e.g. "Amex" or "Chase Checking").
            {" "}<strong>2.</strong> Click <strong>Connect bank</strong> — it opens Plaid in your
            browser to sign in. In <strong>Sandbox</strong>, pick any bank and use the test login
            <strong> user_good</strong> / <strong>pass_good</strong>. When it finishes, the account
            shows here and is ready for reports. (The window waits up to 5 minutes for you to finish.)
            {finStatus.accounts.length > 0 && (
              <span className="settings-chips">
                {finStatus.accounts.map((a) => (
                  <span key={a} className="settings-chip">
                    {a}
                    <button type="button" className="settings-chip-x" title="Disconnect" onClick={async () => {
                      try { await finance.disconnectAccount(a); await refreshFinance(); } catch (e) { setFinError(String(e)); }
                    }}>×</button>
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>


        <div className="settings-row" data-group="voice">
          <span className="settings-label">Read-aloud voices</span>
          <span className="settings-value settings-tts-keys">
            <input
              className="settings-input"
              type="password"
              placeholder="OpenAI API key (sk-…)"
              value={openaiKey}
              onChange={(e) => { setOpenaiKeyState(e.target.value); setOpenaiKey(e.target.value); }}
              autoComplete="off"
              spellCheck={false}
            />
            {openaiKey.trim() && (
              <div className="tts-voice-picker">
                <div className="tts-voice-picker-head">
                  {openaiSel.length ? `OpenAI: showing ${openaiSel.length} of ${OPENAI_VOICES.length}` : `OpenAI: showing all ${OPENAI_VOICES.length} — check some to limit`}
                </div>
                <div className="tts-voice-picker-list">
                  {OPENAI_VOICES.map((v) => (
                    <label key={v} className="tts-voice-pick">
                      <input type="checkbox" checked={openaiSel.includes(v)} onChange={() => toggleOpenaiVoice(v)} />
                      <span>{v[0].toUpperCase()}{v.slice(1)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <input
              className="settings-input"
              type="password"
              placeholder="ElevenLabs API key"
              value={elevenKey}
              onChange={(e) => { setElevenKeyState(e.target.value); setElevenKey(e.target.value); }}
              autoComplete="off"
              spellCheck={false}
            />
            {elevenKey.trim() && elevenVoices.length > 0 && (
              <div className="tts-voice-picker">
                <div className="tts-voice-picker-head">
                  {elevenSel.length ? `Showing ${elevenSel.length} of ${elevenVoices.length}` : `Showing all ${elevenVoices.length} — check some to limit`}
                </div>
                <div className="tts-voice-picker-list">
                  {elevenVoices.map((v) => (
                    <label key={v.id} className="tts-voice-pick">
                      <input
                        type="checkbox"
                        checked={elevenSel.includes(v.id)}
                        onChange={() => toggleElevenVoice(v.id)}
                      />
                      <span>{v.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            <input
              className="settings-input"
              type="password"
              placeholder="Unreal Speech API key"
              value={unrealKey}
              onChange={(e) => { setUnrealKeyState(e.target.value); setUnrealKey(e.target.value); }}
              autoComplete="off"
              spellCheck={false}
            />
            {unrealKey.trim() && (
              <div className="tts-voice-picker">
                <div className="tts-voice-picker-head">
                  {unrealSel.length ? `Unreal: showing ${unrealSel.length} of ${UNREAL_VOICES.length}` : `Unreal: showing all ${UNREAL_VOICES.length} — check some to limit`}
                </div>
                <div className="tts-voice-picker-list">
                  {UNREAL_VOICES.map((v) => (
                    <label key={v} className="tts-voice-pick">
                      <input type="checkbox" checked={unrealSel.includes(v)} onChange={() => toggleUnrealVoice(v)} />
                      <span>{v}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </span>
          <span className="settings-hint">
            Optional. The card play button uses your Mac's built-in voices by default;
            add an <strong>OpenAI</strong>, <strong>ElevenLabs</strong>, or
            {" "}<strong>Unreal Speech</strong> key to unlock premium AI voices in the
            picker. Keys are stored locally on this device and the audio is fetched
            natively (never through the browser). Cloud voices use the provider's API and
            may incur per-use cost.
          </span>
        </div>

        <div className="settings-row" data-group="voice">
          <span className="settings-label">Agent</span>
          <span className="settings-value">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ color: "var(--ink-faint)" }}>Provider</span>
              <select className="settings-input" style={{ maxWidth: 210 }} value={agentProvider}
                onChange={(e) => switchAgentProvider(e.target.value as AgentProvider)}>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI</option>
                <option value="grok">Grok (xAI)</option>
                <option value="local">Local (Ollama / LM Studio)</option>
              </select>
            </div>
            {agentProvider !== "local" && (
              <input
                className="settings-input"
                type="password"
                placeholder={agentProvider === "anthropic" ? "Anthropic API key (sk-ant-…)" : agentProvider === "grok" ? "xAI API key (xai-…)" : "OpenAI API key (sk-…)"}
                value={agentKeyVal}
                onChange={(e) => { setAgentKeyVal(e.target.value); setAgentKeyFor(agentProvider, e.target.value); }}
                autoComplete="off"
                spellCheck={false}
              />
            )}
            <input
              className="settings-input"
              style={{ marginTop: 8 }}
              placeholder={AGENT_DEFAULT_MODEL[agentProvider] ? `Model (default ${AGENT_DEFAULT_MODEL[agentProvider]})` : agentProvider === "anthropic" ? "Model (default claude-sonnet-5)" : "Model (e.g. llama3.1)"}
              value={agentModelVal}
              onChange={(e) => { setAgentModelVal(e.target.value); setAgentModelFor(agentProvider, e.target.value); }}
              spellCheck={false}
            />
            {agentProvider !== "anthropic" && (
              <input
                className="settings-input"
                style={{ marginTop: 8 }}
                placeholder={agentProvider === "local" ? "Base URL (e.g. http://localhost:11434/v1)" : "Base URL override (optional)"}
                value={agentBaseVal}
                onChange={(e) => { setAgentBaseVal(e.target.value); setAgentBaseUrlFor(agentProvider, e.target.value); }}
                spellCheck={false}
              />
            )}
            <div className="settings-radiogroup">
              <span className="settings-radiogroup-label">Voice input</span>
              <div className="settings-radiogroup-opts">
                <label className="settings-radio">
                  <input type="radio" name="stt-engine" checked={sttEngine === "whisper"}
                    onChange={() => { setSttEngineState("whisper"); setSttEngine("whisper"); }} />
                  <span>Whisper (OpenAI)</span>
                </label>
                <label className="settings-radio">
                  <input type="radio" name="stt-engine" checked={sttEngine === "native"}
                    onChange={() => { setSttEngineState("native"); setSttEngine("native"); }} />
                  <span>On-device (Apple)</span>
                </label>
              </div>
            </div>
            <div className="settings-radiogroup">
              <span className="settings-radiogroup-label">Voice output</span>
              <div className="settings-radiogroup-opts">
                {([["auto", "Auto"], ["speaker", "Speaker"], ["receiver", "Earpiece"]] as [AudioOutput, string][]).map(([val, label]) => (
                  <label key={val} className="settings-radio">
                    <input type="radio" name="audio-output" checked={audioOut === val}
                      onChange={() => { setAudioOutState(val); setAudioOutput(val); }} />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </span>
          <span className="settings-hint">
            Powers the in-app agent — the <strong>chat</strong> button in the dock. Tap the
            mic and speak; it listens, sends on a pause, and reads the reply aloud. The
            agent reads and edits notes in the current folder, always asking once before
            it writes. <strong>Voice input</strong> transcribes with OpenAI Whisper by
            default (reuses your OpenAI key above); switch to <strong>On-device</strong> to
            use Apple's speech recognition, which stays entirely on this device. Keys are
            stored locally; note contents and the model call stay in Order's Rust core.
          </span>
        </div>

        <div className="settings-row" data-group="usage">
          <span className="settings-label">Usage &amp; cost</span>
          <span className="settings-value">
            <div className="settings-usage">
              {usage.rows.map((r) => (
                <div key={r.key} className={"settings-usage-row" + (r.keyed ? "" : " is-free")}>
                  <span className="settings-usage-name">{r.label}</span>
                  <span className="settings-usage-detail">{r.detail}</span>
                  <span className="settings-usage-cost">{r.keyed ? formatUSD(r.cost) : "free"}</span>
                </div>
              ))}
              <div className="settings-usage-row settings-usage-total">
                <span className="settings-usage-name">Estimated total</span>
                <span className="settings-usage-detail" />
                <span className="settings-usage-cost">{formatUSD(usage.total)}</span>
              </div>
            </div>
            <button type="button" className="settings-reset-usage" onClick={() => { resetUsage(); setUsageTick((n) => n + 1); }}>
              Reset counters
            </button>
          </span>
          <span className="settings-hint">
            A local, estimated tally of what the voice agent has cost across the services
            you've keyed — Anthropic for chat, OpenAI Whisper for dictation, and
            OpenAI / ElevenLabs for read-aloud. Counted on this device only; nothing is
            reported anywhere. Costs are estimates from published rates and can drift;
            on-device Apple speech is free. Check each provider's dashboard for the
            authoritative bill.
          </span>
        </div>

        {(() => {
          // Show the calendar list whenever we actually have calendars OR the
          // status reads authorized — decoupled from the exact status string so
          // an unusual macOS state still lets you pick calendars.
          const showCals = appleCals.length > 0 || appleStatus === "authorized";
          return (
        <div className="settings-row" data-group="calendar">
          <span className="settings-label">Apple Calendar</span>
          {appleErr && <span className="settings-hint" style={{ color: "#d9534f" }}>{appleErr}</span>}
          {appleStatus !== "unsupported" && (
            <span className="settings-value" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {!showCals && (
                <button
                  type="button"
                  className="settings-btn"
                  disabled={appleBusy || appleStatus === "denied"}
                  onClick={async () => {
                    setAppleBusy(true); setAppleErr(null);
                    try { const m = await import("../lib/apple-cal"); await m.requestAccess(); await refreshApple(); }
                    catch (e) { setAppleErr(String(e)); } finally { setAppleBusy(false); }
                  }}
                >
                  {appleBusy ? "Requesting…" : "Grant calendar access"}
                </button>
              )}
              <button
                type="button"
                className="settings-btn"
                disabled={appleBusy}
                onClick={async () => { setAppleBusy(true); setAppleErr(null); try { await refreshApple(); } finally { setAppleBusy(false); } }}
                title="Re-check calendar access and reload the calendar list"
              >
                Refresh
              </button>
              {appleStatus && <span className="settings-hint" style={{ margin: 0 }}>access: {appleStatus}</span>}
            </span>
          )}
          {appleStatus === "denied" && (
            <span className="settings-hint">
              Calendar access was denied. Enable it in System Settings → Privacy &amp; Security →
              Calendars (macOS) or Settings → Privacy → Calendars (iOS), then click Refresh.
            </span>
          )}
          {appleStatus === "unsupported" && (
            <span className="settings-hint">System-calendar sync is available on macOS and iOS.</span>
          )}
          {showCals && (
            <>
              <span className="settings-hint">Tick the calendars to include when importing a day's events.</span>
              <ul className="gcal-account-list">
                {appleCals.map((c) => (
                  <li key={c.id} className="gcal-account-row">
                    <label className="settings-toggle">
                      <input
                        type="checkbox"
                        checked={appleIncluded.includes(c.id)}
                        onChange={(e) => setAppleIncluded(toggleAppleCalendar(c.id, e.target.checked))}
                      />
                      <span>{c.title}{c.source ? ` · ${c.source}` : ""}{!c.writable ? " (read-only)" : ""}</span>
                    </label>
                  </li>
                ))}
                {appleCals.length === 0 && (
                  <li className="settings-hint">
                    Access is granted but no calendars were returned. If Calendar.app shows
                    calendars, click Refresh; on older macOS, ensure Order was rebuilt with the
                    calendar entitlement.
                  </li>
                )}
              </ul>
              <span className="settings-hint">
                Assign an event to a calendar with <code>@[Calendar Name]</code> on its spacetime
                line to create it there. Invitations are sent via Google — Apple's calendar API
                can't add guests.
              </span>
            </>
          )}
        </div>
          );
        })()}

        <div className="settings-row" data-group="calendar">
          <span className="settings-label">Reminders</span>
          {reminderErr && <span className="settings-hint" style={{ color: "#d9534f" }}>{reminderErr}</span>}
          {reminderStatus !== "unsupported" ? (
            <span className="settings-value" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {reminderStatus !== "authorized" && reminderStatus !== "writeOnly" && (
                <button
                  type="button"
                  className="settings-btn"
                  disabled={reminderBusy || reminderStatus === "denied"}
                  onClick={async () => {
                    setReminderBusy(true); setReminderErr(null);
                    try { const m = await import("../lib/apple-reminder"); await m.requestAccess(); await refreshReminder(); }
                    catch (e) { setReminderErr(String(e)); } finally { setReminderBusy(false); }
                  }}
                >
                  {reminderBusy ? "Requesting…" : "Grant Reminders access"}
                </button>
              )}
              <button type="button" className="settings-btn" disabled={reminderBusy}
                onClick={async () => { setReminderBusy(true); setReminderErr(null); try { await refreshReminder(); } finally { setReminderBusy(false); } }}>
                Refresh
              </button>
              {reminderStatus && <span className="settings-hint" style={{ margin: 0 }}>access: {reminderStatus}</span>}
            </span>
          ) : (
            <span className="settings-hint">System Reminders are available on macOS and iOS.</span>
          )}
          {reminderStatus === "denied" && (
            <span className="settings-hint">
              Reminders access was denied. Enable it in System Settings → Privacy &amp; Security →
              Reminders (macOS) or Settings → Privacy → Reminders (iOS), then click Refresh.
            </span>
          )}
          <label className="settings-toggle" style={{ marginTop: 4 }}>
            <input
              type="checkbox"
              checked={remindDefault}
              onChange={(e) => { setRemindDefault(e.target.checked); setRemindersDefault(e.target.checked); }}
            />
            <span>Add a reminder to every new event automatically</span>
          </label>
          <span className="settings-hint">
            When on, creating a dated event also sets a system reminder (Reminders access must be granted). Rescheduling the event moves its reminder too. You can also set one per event from its ⋯ menu → “Set reminder”.
          </span>
        </div>

        <div className="settings-row" data-group="calendar">
          <span className="settings-label">
            Google Calendar
            <button
              type="button"
              className="settings-help-btn"
              onClick={() => setGcalHelpOpen((o) => !o)}
              title="How to get these credentials"
              aria-label="How to get these credentials"
            >
              <InfoIcon size={12} strokeWidth={2.2} />
            </button>
          </span>
          {gcalHelpOpen && (
            <div className="settings-help-text">
              These credentials come from <strong>your own</strong> Google Cloud project — a
              one-time, ~10-minute setup. Commercial apps hide this by shipping a Google-verified
              client; bringing your own keeps access under your control and needs no Google review.
              <ol>
                <li>Open the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> and create a project.</li>
                <li><strong>APIs &amp; Services → Library</strong> → enable <strong>Google Calendar API</strong>.</li>
                <li><strong>OAuth consent screen / Branding</strong> → <em>External</em> → add your app name + email.</li>
                <li><strong>Audience</strong> → <strong>Test users</strong> → <strong>Add users</strong> → add the exact Google account(s) you'll connect, and Save. (Required — even in Testing mode, only listed test users can sign in; otherwise you get a <code>403 access_denied</code>.)</li>
                <li><strong>Credentials → Create Credentials → OAuth client ID</strong> → application type <strong>Desktop app</strong>.</li>
                <li>Copy the <strong>Client ID</strong> and <strong>Client secret</strong> into the fields below and Save.</li>
              </ol>
              Order stores these on this device only and uses the <code>calendar.events</code> scope.
            </div>
          )}
          {gcalError && <span className="settings-hint" style={{ color: "#d9534f" }}>{gcalError}</span>}
          {gcal.has_credentials && (
            <span className="settings-hint" style={{ color: "var(--royal)" }}>✓ Credentials saved on this device.</span>
          )}
          {!isIosSync() && (
          <span className="settings-value">
            <input type="text" className="settings-input" placeholder="OAuth Client ID"
              value={gcalId} onChange={(e) => setGcalId(e.target.value)} />
            <input type="password" className="settings-input"
              placeholder={gcal.has_credentials ? "•••••• (secret saved — re-enter to change)" : "OAuth Client Secret"}
              value={gcalSecret} onChange={(e) => setGcalSecret(e.target.value)} />
            <button type="button" className="settings-btn" disabled={gcalBusy || !gcalId || !gcalSecret}
              onClick={async () => {
                setGcalBusy(true); setGcalError(null);
                try { const m = await import("../lib/gcal-accounts"); await m.setCredentials(gcalId, gcalSecret); await refreshGcal(); }
                catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); }
              }}>Save credentials</button>
          </span>
          )}
          <span className="settings-value">
            <button type="button" className="settings-btn" disabled={gcalBusy || (isIosSync() ? !gcal.client_id_ios : !gcal.has_credentials)}
              onClick={async () => {
                setGcalBusy(true); setGcalError(null);
                try { const m = await import("../lib/gcal-accounts"); await m.connectAccount(); await refreshGcal(); }
                catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); }
              }}>{gcalBusy ? "Connecting…" : "Connect Google account"}</button>
          </span>
          {(isIosSync() ? !!gcal.client_id_ios : gcal.has_credentials) && gcal.accounts.length === 0 && (
            <span className="settings-hint">No Google account connected yet — click “Connect Google account”.</span>
          )}
          <ul className="gcal-account-list">
            {gcal.accounts.map((a) => (
              <li key={a} className="gcal-account-row">
                <label className="settings-toggle">
                  <input type="radio" name="gcal-default" checked={gcal.default === a}
                    onChange={async () => { setGcalBusy(true); setGcalError(null); try { const m = await import("../lib/gcal-accounts"); await m.setDefault(a); await refreshGcal(); } catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); } }} />
                  <span>{a}{gcal.default === a ? " (default)" : ""}</span>
                </label>
                <button type="button" className="settings-btn is-danger"
                  onClick={async () => { setGcalBusy(true); setGcalError(null); try { const m = await import("../lib/gcal-accounts"); await m.disconnect(a); await refreshGcal(); } catch (e) { setGcalError(String(e)); } finally { setGcalBusy(false); } }}>Disconnect</button>
              </li>
            ))}
          </ul>
          {isIosSync() && (
            <div className="settings-subsection">
              <label className="settings-label">Google iOS Client ID</label>
              <p className="settings-hint">
                iOS uses a separate Google credential. In Google Cloud → Credentials, create an
                OAuth client of type <strong>iOS</strong> (bundle id <code>com.geetduggal.order</code>),
                and paste its Client ID here. The reversed form must also be set as the app's URL scheme
                at build time. {gcal.client_id_ios ? "✓ iOS Client ID saved on this device." : ""}
              </p>
              <input
                className="settings-input"
                placeholder="123-abc.apps.googleusercontent.com"
                value={iosId}
                onChange={(e) => setIosId(e.target.value)}
              />
              <button
                type="button"
                className="settings-btn"
                disabled={!iosId.trim()}
                onClick={async () => {
                  try { const m = await import("../lib/gcal-accounts"); await m.setIosClientId(iosId.trim()); await refreshGcal(); }
                  catch (e) { setGcalError(String(e)); }
                }}
              >Save iOS Client ID</button>
            </div>
          )}
          <span className="settings-hint">
            Connect a Google account to sync curated events. Credentials come from your own
            Google Cloud project — a "Desktop app" client on desktop, an "iOS" client on the
            phone. The default account hosts events that don't name one.
          </span>
        </div>
        </div>

      </div>
    </div>
  );
}
