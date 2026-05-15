import type { Settings } from '../types'

// Order disables AI features by default. The upstream Tolaria default was true
// (opt-out); Order is opt-in via explicit ai_features_enabled === true in
// settings. This collapses the AI panel, AI command palette items, MCP setup
// prompts, AI Inspector controls, and AI status indicators in a single switch.
export function areAiFeaturesEnabled(settings: Pick<Settings, 'ai_features_enabled'> | null | undefined): boolean {
  return settings?.ai_features_enabled === true
}
