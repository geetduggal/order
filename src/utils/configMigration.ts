import { APP_STORAGE_KEYS, copyLegacyAppStorageKeys, getAppStorageItem } from '../constants/appStorage'
import type { VaultConfig } from '../types'

const MIGRATION_FLAG = APP_STORAGE_KEYS.configMigrationFlag

/** Keys to migrate from localStorage to vault config file. */
const LS_KEYS = {
  zoom: APP_STORAGE_KEYS.zoom,
  viewMode: APP_STORAGE_KEYS.viewMode,
  tagColors: APP_STORAGE_KEYS.tagColors,
  statusColors: APP_STORAGE_KEYS.statusColors,
  propertyModes: APP_STORAGE_KEYS.propertyModes,
} as const

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch {
    return null
  }
}

/**
 * One-time migration: read localStorage values and merge into vault config.
 * Returns the merged config. If already migrated (flag set), returns the loaded config unchanged.
 * Passing null for `loaded` means the vault file didn't exist yet.
 */
export function migrateLocalStorageToVaultConfig(loaded: VaultConfig | null): VaultConfig {
  const base: VaultConfig = loaded ?? {
    zoom: null, view_mode: null, editor_mode: null, tag_colors: null,
    status_colors: null, property_display_modes: null, inbox: null,
  }

  copyLegacyAppStorageKeys()

  // Skip migration if already done
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === '1') return base
  } catch {
    return base
  }

  const result = { ...base }

  // Zoom (localStorage stores as string "80"–"150", vault config stores as fraction 0.8–1.5)
  if (result.zoom === null) {
    try {
      const raw = getAppStorageItem('zoom')
      if (raw !== null) {
        const val = Number(raw)
        if (val >= 80 && val <= 150) result.zoom = val / 100
      }
    } catch { /* ignore */ }
  }

  // View mode
  if (result.view_mode === null) {
    try {
      const raw = getAppStorageItem('viewMode')
      if (raw === 'editor-only' || raw === 'editor-list' || raw === 'all') {
        result.view_mode = raw
      }
    } catch { /* ignore */ }
  }

  // Tag colors
  if (result.tag_colors === null) {
    const colors = readJson<Record<string, string>>(LS_KEYS.tagColors) ?? readJson<Record<string, string>>('laputa:tag-color-overrides')
    if (colors && Object.keys(colors).length > 0) result.tag_colors = colors
  }

  // Status colors
  if (result.status_colors === null) {
    const colors = readJson<Record<string, string>>(LS_KEYS.statusColors) ?? readJson<Record<string, string>>('laputa:status-color-overrides')
    if (colors && Object.keys(colors).length > 0) result.status_colors = colors
  }

  // Property display modes
  if (result.property_display_modes === null) {
    const modes = readJson<Record<string, string>>(LS_KEYS.propertyModes) ?? readJson<Record<string, string>>('laputa:display-mode-overrides')
    if (modes && Object.keys(modes).length > 0) result.property_display_modes = modes
  }

  // Mark migration as done
  try {
    localStorage.setItem(MIGRATION_FLAG, '1')
  } catch { /* ignore */ }

  return result
}
