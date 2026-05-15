import type { Settings, NoteWidthMode } from '../types'
import { trackEvent } from '../lib/telemetry'
import {
  trackAiFeaturesEnabledChanged,
  trackDateDisplayFormatChanged,
  trackDefaultNoteWidthChanged,
  trackSidebarTypePluralizationChanged,
} from '../lib/productAnalytics'
import { areAiFeaturesEnabled } from '../lib/aiFeatures'
import {
  DEFAULT_DATE_DISPLAY_FORMAT,
  normalizeDateDisplayFormat,
  type DateDisplayFormat,
} from '../utils/dateDisplay'
import { DEFAULT_NOTE_WIDTH_MODE, normalizeNoteWidthMode } from '../utils/noteWidth'

export interface SettingsPreferenceDraft {
  analytics: boolean
  aiFeaturesEnabled: boolean
  dateDisplayFormat: DateDisplayFormat
  defaultNoteWidth: NoteWidthMode
  multiWorkspaceEnabled: boolean
  sidebarTypePluralizationEnabled: boolean
}

export function trackTelemetryConsentChange(previousAnalytics: boolean, nextAnalytics: boolean): void {
  if (!previousAnalytics && nextAnalytics) trackEvent('telemetry_opted_in')
  if (previousAnalytics && !nextAnalytics) trackEvent('telemetry_opted_out')
}

export function trackSettingsPreferenceChanges(settings: Settings, draft: SettingsPreferenceDraft): void {
  const previousAiFeaturesEnabled = areAiFeaturesEnabled(settings)
  if (previousAiFeaturesEnabled !== draft.aiFeaturesEnabled) {
    trackAiFeaturesEnabledChanged(draft.aiFeaturesEnabled)
  }

  const previousDateDisplayFormat = normalizeDateDisplayFormat(settings.date_display_format) ?? DEFAULT_DATE_DISPLAY_FORMAT
  if (previousDateDisplayFormat !== draft.dateDisplayFormat) {
    trackDateDisplayFormatChanged(draft.dateDisplayFormat)
  }

  const previousNoteWidth = normalizeNoteWidthMode(settings.note_width_mode) ?? DEFAULT_NOTE_WIDTH_MODE
  if (previousNoteWidth !== draft.defaultNoteWidth) {
    trackDefaultNoteWidthChanged(draft.defaultNoteWidth)
  }

  const previousPluralization = settings.sidebar_type_pluralization_enabled ?? true
  if (previousPluralization !== draft.sidebarTypePluralizationEnabled) {
    trackSidebarTypePluralizationChanged(draft.sidebarTypePluralizationEnabled)
  }

  const previousMultiWorkspaceEnabled = settings.multi_workspace_enabled === true
  if (previousMultiWorkspaceEnabled !== draft.multiWorkspaceEnabled) {
    trackEvent('multi_workspace_mode_changed', { enabled: draft.multiWorkspaceEnabled ? 1 : 0 })
  }
}
