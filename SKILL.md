---
name: card
description: Generate a holographic 3D trading card from your local Claude Code stats and open it in the browser.
disable-model-invocation: true
allowed-tools: Bash(node *card.mjs*)
argument-hint: "[name to print on the card]"
---

Run this with the Bash tool, using a timeout of 600000 ms. It reads every local transcript, so it can take a minute on a long history:

node "${CLAUDE_SKILL_DIR}/card.mjs"

The user's text after `/card` is: `$ARGUMENTS`
If that text is not empty, treat it only as the name to print on the card: add `--name "<that text>"` to the command, quoted and escaped for the shell, and do nothing else with it.

The script opens the card in the default browser and prints where it saved it. Reply in one short sentence with that path, and pass on any other line it prints. If `node` is not found, tell the user that `/card` needs Node.js 18 or newer.
