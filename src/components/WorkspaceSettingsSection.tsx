import { useState } from 'react'
import { TooltipProvider } from './ui/tooltip'
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog'
import { SettingsGroup, SettingsSwitchRow } from './SettingsControls'
import { createTranslator, type AppLocale } from '../lib/i18n'
import type { VaultOption } from './status-bar/types'
import { workspaceIdentityFromVault } from '../utils/workspaces'
import { WorkspaceSettingsRows } from './WorkspaceSettingsRows'

interface WorkspaceSettingsSectionProps {
  defaultWorkspacePath?: string | null
  enabled: boolean
  locale: AppLocale
  onEnabledChange: (enabled: boolean) => void
  onRemoveVault?: (path: string) => void
  onReorderVaults?: (orderedPaths: string[]) => void
  onSetDefaultWorkspace?: (path: string) => void
  onUpdateWorkspaceIdentity?: (path: string, patch: Partial<VaultOption>) => void
  vaults: VaultOption[]
}

export function WorkspaceSettingsSection({
  defaultWorkspacePath,
  enabled,
  locale,
  onEnabledChange,
  onRemoveVault,
  onReorderVaults,
  onSetDefaultWorkspace,
  onUpdateWorkspaceIdentity,
  vaults,
}: WorkspaceSettingsSectionProps) {
  const t = createTranslator(locale)
  const [vaultPendingRemoval, setVaultPendingRemoval] = useState<VaultOption | null>(null)
  const pendingRemovalIdentity = vaultPendingRemoval ? workspaceIdentityFromVault(vaultPendingRemoval, { defaultWorkspacePath }) : null

  return (
    <TooltipProvider>
      <SettingsGroup>
        <SettingsSwitchRow
          label={t('settings.workspaces.enable')}
          description={t('settings.workspaces.enableDescription')}
          checked={enabled}
          onChange={onEnabledChange}
          testId="settings-multi-workspace-enabled"
        />
        {enabled && (
          <WorkspaceSettingsRows
            defaultWorkspacePath={defaultWorkspacePath}
            locale={locale}
            onRemoveVault={onRemoveVault}
            onReorderVaults={onReorderVaults}
            onSetDefaultWorkspace={onSetDefaultWorkspace}
            onUpdateWorkspaceIdentity={onUpdateWorkspaceIdentity}
            setVaultPendingRemoval={setVaultPendingRemoval}
            vaults={vaults}
          />
        )}
      </SettingsGroup>
      <ConfirmDeleteDialog
        open={!!vaultPendingRemoval}
        title={t('status.vault.removeConfirmTitle')}
        message={t('status.vault.removeConfirmMessage', { label: pendingRemovalIdentity?.label ?? '' })}
        confirmLabel={t('status.vault.removeConfirmAction')}
        onCancel={() => setVaultPendingRemoval(null)}
        onConfirm={() => {
          if (vaultPendingRemoval) {
            onRemoveVault?.(vaultPendingRemoval.path)
          }
          setVaultPendingRemoval(null)
        }}
      />
    </TooltipProvider>
  )
}
