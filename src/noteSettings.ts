import type { LTOptions } from "./settings";

function stringList(value: unknown): string[] | undefined {
    if (Array.isArray(value) && value.every(item => typeof item === "string")) return value;
    return undefined;
}

/**
 * Apply the note-specific settings from a note's properties (frontmatter).
 * Lists of words, rules and categories are added to the global ones.
 */
export function applyNoteSettings(
    options: Readonly<LTOptions>,
    frontmatter: Record<string, unknown> | null | undefined,
): Readonly<LTOptions> {
    if (frontmatter == null) return options;

    const language = frontmatter["lt-language"] ?? frontmatter["lt_language"];
    const preferredLanguages = stringList(frontmatter["lt-preferredLanguages"]);
    const picky = frontmatter["lt-picky"];
    const autoCheck = frontmatter["lt-autoCheck"];
    const dictionary = stringList(frontmatter["lt-dictionary"]);
    const disabledRules = stringList(frontmatter["lt-disabledRules"]);
    const disabledCategories = stringList(frontmatter["lt-disabledCategories"]);

    // Beware: shallow clone
    const settings = { ...options };
    if (typeof language === "string") settings.staticLanguage = language;
    if (preferredLanguages) settings.preferredLanguages = preferredLanguages;
    if (typeof autoCheck === "boolean") settings.shouldAutoCheck = autoCheck;
    if (typeof picky === "boolean") settings.pickyMode = picky;
    if (dictionary) settings.dictionary = [...settings.dictionary, ...dictionary];
    if (disabledRules) settings.disabledRules = [...settings.disabledRules, ...disabledRules];
    if (disabledCategories)
        settings.disabledCategories = [...settings.disabledCategories, ...disabledCategories];
    return settings;
}
