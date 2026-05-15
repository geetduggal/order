# Order

A specialized markdown note-taking app for Weather Resistant Productivity.

Order is a fork of [Tolaria](https://github.com/refactoringhq/tolaria) (AGPL-3.0-or-later).
See `NOTICE` for attribution and `TOLARIA-TRADEMARKS.md` for the upstream trademark policy.

## Design

The design philosophy and visual language live in `~/Documents/Dropbox/order/`:
- `order-design-doc.md` — thesis, requirements, architecture notes
- `mockups/` — interactive HTML mockups of every view

## Status

Early. The fork preserves Tolaria's editor and vault engine and re-skins it as
Order. Order's specific shell (Stream view with 2D resizable card grid,
Notable Folder sections, Day/Week/Month/Year calendars, Public publish
pipeline) is being layered on top.

## Develop

```bash
pnpm install
pnpm tauri dev
```

## License

AGPL-3.0-or-later (inherited from Tolaria). See `LICENSE`.
