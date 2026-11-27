# Seti (Cursor) file icon theme

Cursor's default file icons, packaged as their own icon theme. Cursor ships VS Code's built-in Seti theme with a few changes of its own. This extension holds those changes so the stock `theme-seti` extension stays unmodified.

Differences from stock Seti (`vs-seti`):

- `icons/seti.woff` is Cursor's copy of the Seti font. Every glyph the theme uses maps to the same character as in the stock font.
- `icons/cursor.svg`, `icons/cursor_mini.svg` and `icons/cursor_mini_light.svg` come from Cursor.
- In `icons/vs-seti-icon-theme.json`, `.tsv` uses the CSV icon, `.env` uses the config icon, and the `cursor-ai` language uses the Cursor icon, in both light and dark.

The theme JSON is based on Thrice's newer upstream Seti, so it keeps the `prompt`, `instructions`, `skill`, `dotenv` and `chatagent` mappings, which Cursor's older copy lacks. If you refresh stock Seti from upstream, copy its JSON here and re-apply the three changes above.

Theme id: `vs-seti-cursor`. Seti UI icons are MIT licensed; see `ThirdPartyNotices.txt`.
