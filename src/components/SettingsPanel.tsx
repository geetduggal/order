// Settings panel — opened from the gear icon in the bottom-left.
// Currently just the vault location: shows the active path and lets
// the user pick a different folder (native dialog) or reset to the
// default. The parent persists the choice and reloads the vault.

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { X as XIcon, Folder as FolderIcon, Info as InfoIcon } from "lucide-react";
import { vaultRoot, defaultVaultRoot, getVaultOverride, isIos, isIosSync } from "../lib/vault";
import { vaultFs } from "../lib/vault-fs";
import { getOpenaiKey, setOpenaiKey, getElevenKey, setElevenKey, getElevenSelected, setElevenSelected, listElevenVoices, OPENAI_VOICES, getOpenaiSelected, setOpenaiSelected } from "../lib/tts";
import { getAgentKey, setAgentKey } from "../lib/agent";
import { getSttEngine, setSttEngine, type SttEngine } from "../lib/voice";
// Pure localStorage helper — static-imported so the checkbox toggle is
// SYNCHRONOUS (a dynamic import defers setState a tick, and the controlled
// checkbox reverts in between, so the box won't tick).
import { toggleIncludedCalendar as toggleAppleCalendar } from "../lib/apple-cal";

export function SettingsPanel({
  onChangeVault, onClose,
  johnnyDecimal, johnnyDecimalBusy, onToggleJohnnyDecimal, onAssignMissingJdIds,
  weekHubFolder, onSetWeekHubFolder, folderOptions,
  badgeEnabled, badgeCount, onToggleBadge,
}: {
  onChangeVault: (path: string | null) => Promise<void>;
  onClose: () => void;
  johnnyDecimal: boolean;
  johnnyDecimalBusy: boolean;
  onToggleJohnnyDecimal: (enable: boolean) => Promise<void>;
  onAssignMissingJdIds: () => Promise<void>;
  weekHubFolder: string;
  onSetWeekHubFolder: (ref: string) => void;
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
  const [anthropicKey, setAnthropicKeyState] = useState<string>(() => getAgentKey());
  const [sttEngine, setSttEngineState] = useState<SttEngine>(() => getSttEngine());
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

  const [gcal, setGcal] = useState<import("../lib/gcal-accounts").AccountsView>({ accounts: [], default: null, has_credentials: false, client_id: "", client_id_ios: "" });
  const [gcalId, setGcalId] = useState("");
  const [gcalSecret, setGcalSecret] = useState("");
  const [gcalBusy, setGcalBusy] = useState(false);
  const [gcalError, setGcalError] = useState<string | null>(null);
  const [gcalHelpOpen, setGcalHelpOpen] = useState(false);
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

        <div className="settings-row">
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

        <div className="settings-row">
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

        <div className="settings-row">
          <span className="settings-label">Weekly hub</span>
          <span className="settings-value">
            <input
              // Uncontrolled (keyed to the current setting so external changes
              // reflect) so partial typing shows; commit only a real folder or
              // empty, so a half-typed name never thrashes the setting.
              key={weekHubFolder}
              className="settings-input"
              list="settings-week-hub-options"
              placeholder="Notable folder (blank = off)"
              defaultValue={weekHubFolder}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === "" || folderOptions.includes(v)) onSetWeekHubFolder(v);
              }}
            />
            <datalist id="settings-week-hub-options">
              {folderOptions.map((f) => <option key={f} value={f} />)}
            </datalist>
            {weekHubFolder && (
              <button type="button" className="settings-btn" onClick={() => onSetWeekHubFolder("")}>Clear</button>
            )}
          </span>
          <span className="settings-hint">
            Pins this folder's Main Document above the <strong>Week</strong> view as an
            editable "one stop shop" — the real editor, saving to the folder's doc like
            anywhere else. Drag the divider to resize (persisted); blank turns it off and
            the week grid fills the screen. New events also default to this folder.
          </span>
        </div>

        <div className="settings-row">
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
            the badge shows.{!weekHubFolder && <> Set a <strong>Weekly hub</strong> folder
            above so there's something to count (the count is 0 until then).</>}
          </span>
        </div>

        <div className="settings-row">
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
          </span>
          <span className="settings-hint">
            Optional. The card play button uses your Mac's built-in voices by default;
            add an <strong>OpenAI</strong> or <strong>ElevenLabs</strong> key to unlock
            premium AI voices in the voice picker. Keys are stored locally on this device
            and the audio is fetched natively (never through the browser). Cloud voices
            use the provider's API and may incur per-use cost.
          </span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Agent</span>
          <span className="settings-value">
            <input
              className="settings-input"
              type="password"
              placeholder="Anthropic API key (sk-ant-…)"
              value={anthropicKey}
              onChange={(e) => { setAnthropicKeyState(e.target.value); setAgentKey(e.target.value); }}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="settings-stt-engine" style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 8, fontSize: "0.9rem" }}>
              <span style={{ color: "var(--ink-faint)" }}>Voice input:</span>
              <label style={{ display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                <input type="radio" name="stt-engine" checked={sttEngine === "whisper"}
                  onChange={() => { setSttEngineState("whisper"); setSttEngine("whisper"); }} />
                <span>Whisper (OpenAI)</span>
              </label>
              <label style={{ display: "flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
                <input type="radio" name="stt-engine" checked={sttEngine === "native"}
                  onChange={() => { setSttEngineState("native"); setSttEngine("native"); }} />
                <span>On-device (Apple)</span>
              </label>
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

        {(() => {
          // Show the calendar list whenever we actually have calendars OR the
          // status reads authorized — decoupled from the exact status string so
          // an unusual macOS state still lets you pick calendars.
          const showCals = appleCals.length > 0 || appleStatus === "authorized";
          return (
        <div className="settings-row">
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

        <div className="settings-row">
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
  );
}
