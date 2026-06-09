# Order — Claude Code skills

Claude Code skills that pair with the Order vault.

Each skill is its own directory containing a `SKILL.md` (the skill
definition Claude reads at load time) plus any supporting files
the skill needs.

## Installing

Copy a skill directory into your local skills tree:

```bash
cp -R skills/google-calendar-to-order ~/.claude/skills/
```

Claude Code will pick it up on the next session start. Invoke it
via any of the trigger phrases listed in the skill's frontmatter
(e.g. `"import my google calendar to order"`), or run
`/google-calendar-to-order` directly.

## Skills

- [`google-calendar-to-order`](./google-calendar-to-order/) — pull
  events from Google Calendar and write them into the vault as
  Obsidian Full Calendar-style markdown notes, confirming each
  event's Notable Folder + filename + time interactively before
  it lands on disk.
