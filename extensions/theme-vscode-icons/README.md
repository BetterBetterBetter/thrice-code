# VSCode Icons (built-in)

File icon theme imported from the [vscode-icons](https://github.com/vscode-icons/vscode-icons) extension, v13.0.0 (MIT, see `LICENSE.txt`).

Only the generated theme is bundled: `fileicons/vscode-icons-icon-theme.json` and its SVGs in `fileicons/images/`. The upstream extension's runtime (commands, `vsicons.*` settings, theme regeneration) is not included, so the theme uses upstream's default associations.

To update: copy `icons/*` from a newer vscode-icons release into `fileicons/images/`, and regenerate the theme JSON from its `dist/src/vsicons-icon-theme.json`, rewriting `../../icons/` to `./images/`.
