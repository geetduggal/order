import { describe, expect, it } from 'vitest'
import { APP_COMMAND_IDS, APP_COMMAND_MENU_SECTIONS } from './appCommandCatalog'

describe('appCommandCatalog', () => {
  it('keeps the AI panel toggle in the View menu', () => {
    const viewMenu = APP_COMMAND_MENU_SECTIONS.find(section => section.label === 'View')

    expect(viewMenu?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        commandId: APP_COMMAND_IDS.viewToggleAiChat,
        label: 'Toggle AI Panel',
        menuItemId: APP_COMMAND_IDS.viewToggleAiChat,
      }),
    ]))
  })
})
