# Language Tool

Spelling and grammar checking in [Obsidian](https://obsidian.md) with [LanguageTool](https://languagetool.org/), on your own LanguageTool server or on LanguageTool's public and Premium servers.

<img src="demos/image.png" style="border:1px solid black" />

Language Tool is a fork of [obsidian-languagetool](https://github.com/wrenger/obsidian-languagetool) by Lars Wrenger, which is a fork of [obsidian-languagetool-plugin](https://github.com/Clemens-E/obsidian-languagetool-plugin) by Clemens Ertle. See [Credits and licence](#credits-and-licence).

## Changes from the original

- **Preferred languages.** Auto detection can be told which languages you write in, so a short paragraph with a typo is no longer checked as German, Slovenian or Esperanto.
- **A language for each paragraph.** With your own server, every paragraph can be checked in its own language, so a note can mix English and Spanish, for example.
- A note language given without a variety (`lt-language: en`) is checked in the variety chosen in the settings. Before, it silently turned off spell checking.
- Long notes are checked in parts, so they no longer fail on the public server's limit of 20,000 characters per request.
- Auto-check keeps a separate state for every open note. Before, editing two notes in quick succession could leave the first unchecked and check the second at the wrong positions.
- Text edited while a check is running is checked again once the check has finished.
- Choosing a suggestion from the right-click menu replaces the right word.
- "Accept all suggestions" skips suggestions that overlap another one, instead of garbling the text.
- "Add to dictionary" works for every kind of spelling match and always syncs with LanguageTool Premium, from the tooltip, the menu and the command.
- A note's `lt-dictionary` adds to your ignored words instead of replacing them.
- Changing the server loads the language list from the new server, once you have stopped typing.
- Loading the language list and syncing the dictionary no longer delay starting Obsidian.
- The synonyms setting says that synonyms are looked up on LanguageTool's servers, even when you use your own.

## Installation

Language Tool is not in the community plugin list. To install it, build it from source:

1. Install [Bun](https://bun.sh), then run `bun install` and `bun run build` in this repository.
2. Copy `main.js`, `styles.css` and `manifest.json` into `VaultFolder/.obsidian/plugins/language-tool/`.
3. In Obsidian, enable Language Tool under Settings → Community plugins.

## Usage

Hotkeys for the commands can be set under Settings → Hotkeys; search for "Language Tool". Make sure they do not clash with existing hotkeys. You may want to turn off Obsidian's own spellcheck (Settings → Editor → Spellcheck).

- **Check text** checks the whole note, or only the selected text. Underlined words show suggestions when you hover over them, with the option to add the word to your dictionary or to disable the rule.
- **Clear suggestions** removes all underlines.
- **Toggle automatic checking** turns checking as you type on or off.
- **Accept all suggestions** applies the first suggestion of every underline.

LanguageTool detects the language of the text it checks unless you choose a static language under Settings → Language Tool → Static language. It detects one language for each request: "Check text" sends the whole note, and automatic checking sends the paragraphs you have just edited.

### Preferred languages

Detection only sees the text being checked, so a short paragraph with a typo is sometimes detected as an unrelated language ("Teh hous" as Slovenian, for example). Under Settings → Language Tool → Preferred languages, add the languages you write in, and detection will favour them. Text that is clearly in another language is still detected as such.

"Only use these languages" checks everything as one of the preferred languages. It stops detection mistakes completely, but quotations in other languages are then marked as errors.

### A language for each paragraph

As a note is checked in one language, a note that mixes languages has the paragraphs in the other language marked as errors. "Detect the language of each paragraph" checks every paragraph, heading and list item in a separate request, so each gets its own language. A phrase in another language inside a paragraph is still checked in the paragraph's language. Short paragraphs are easily misdetected, so use it together with preferred languages.

It sends one request per paragraph, which the public and Premium servers would refuse, so it is only available with your own server.

### Ignored words

Words can be added to the dictionary from the editor and removed again under Settings → Language Tool → Spellcheck dictionary.

## Note-specific settings

These properties override the settings for one note:

```md
---
lt-language: en-US     # text: language code or "auto"
lt-preferredLanguages: # multitext: languages favoured by "auto", replacing the global ones
  - en
  - es
lt-picky: true         # boolean: more style suggestions
lt-autoCheck: true     # boolean: check as you type
lt-dictionary:         # multitext: ignored words, added to the global ones
  - foo
  - bar
lt-disabledRules:      # multitext: ignored rules, added to the global ones
  - ARROWS
lt-disabledCategories: # multitext: ignored categories, added to the global ones
  - STYLE
---

# Some note...
```

## Privacy

With the public or Premium server, the text you check is sent to LanguageTool. To keep your notes on your computer, run [your own LanguageTool server](https://dev.languagetool.org/http-server), choose the custom endpoint and set its URL, for example `http://localhost:8081`.

"Find synonyms" always uses LanguageTool's servers, whichever server you check with, and sends the sentence around the selected word.

## Premium accounts

Language Tool supports LanguageTool Premium. You need a Premium account and an API key, which you can create at <https://languagetool.org/editor/settings/access-tokens>. Choose the premium endpoint and enter your email address and API key in the settings.

Please report problems with Language Tool in this repository, not to LanguageTool or to the original plugin's authors.

## Development

- `bun run build` runs Obsidian's official ESLint plugin ([eslint-plugin-obsidianmd](https://github.com/obsidianmd/eslint-plugin)) on every source file, the scripts, the tests and `package.json`, and stops at the first warning. It then type-checks and builds `main.js`.
- `bun run lint` runs the linter on its own.
- `bun test` runs the tests. The tests in `src/test/server.test.ts` need a LanguageTool server at `http://localhost:8081`, or the one given in `LT_SERVER`, and are skipped when none is reachable.

## Credits and licence

Language Tool is based on the work of Lars Wrenger ([obsidian-languagetool](https://github.com/wrenger/obsidian-languagetool)), Clemens Ertle ([obsidian-languagetool-plugin](https://github.com/Clemens-E/obsidian-languagetool-plugin)), Matthew Meyers and the other contributors to those projects, whose commits are kept in this repository's history.

Like the original, it is free software under the [GNU Affero General Public License version 3](LICENSE.md), or any later version.
