import {
    App,
    Command,
    Editor,
    editorInfoField,
    MarkdownView,
    Menu,
    Notice,
    Plugin,
    PluginManifest,
    setIcon,
    setTooltip,
    TFile,
} from "obsidian";
import { EditorView } from "@codemirror/view";
import { ChangeSpec, StateEffect } from "@codemirror/state";
import { endpointFromUrl, LTOptions, LTSettings, LTSettingsTab, SUGGESTIONS } from "./settings";
import * as api from "./api";
import { ChangeTracker } from "./editor/changes";
import { underlineExtension } from "./editor/extension";
import {
    addUnderline,
    clearAllUnderlines,
    clearMatchingUnderlines,
    clearUnderlinesInRange,
    underlineDecoration,
} from "./editor/underlines";
import {
    cmpIgnoreCase,
    errorMessage,
    isSpelling,
    nonOverlapping,
    setDifference,
    setIntersect,
    setUnion,
    suggestionChange,
} from "./helpers";
import * as markdown from "./markdown/parser";
import { applyNoteSettings } from "./noteSettings";
import { openSuggestions } from "./editor/tooltip";
import { SynonymEngine } from "./synonyms/engine";

export default class LanguageToolPlugin extends Plugin {
    public settings: LTSettings;
    private statusBarItem?: HTMLElement;

    /// Number of checks in progress, shown in the status bar
    private runningChecks = 0;

    public logs: string[] = [];
    private settingTab: LTSettingsTab;
    /// Spanish synonyms, found by a Java program the plugin starts when they are first asked for
    private synonymEngine?: SynonymEngine;

    // Used to temporarily disable auto-checking errors
    public autoCheckSuppressErrorsUntil: number = 0;

    constructor(app: App, manifest: PluginManifest) {
        super(app, manifest);

        this.settingTab = new LTSettingsTab(this.app, this);
        this.settings = new LTSettings(this.settingTab);
    }

    public async onload(): Promise<void> {
        // Settings
        await this.settings.load();
        this.addSettingTab(this.settingTab);

        // Status bar
        this.statusBarItem = this.addStatusBarItem();
        this.statusBarItem.addClass("status-bar-item-icon", "lt-status-bar-btn");
        this.statusBarItem.onclick = () => this.handleStatusBarClick();
        this.setStatusBarReady();

        // Editor functionality
        this.registerEditorExtension(underlineExtension(this));

        this.synonymEngine = new SynonymEngine(
            this.app.vault.adapter,
            this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
            () => ({
                java: this.settings.options.synonymsJava,
                languageTool: this.settings.options.synonymsLanguageTool,
            }),
        );

        // Commands
        this.registerCommands();

        this.registerMenuItems();

        // Configure frontmatter suggestions
        if (this.settings.options.injectProperties) this.injectProperties(true);

        // Spellcheck Dictionary
        const dictionary: Set<string> = new Set(
            this.settings.options.dictionary.map(w => w.trim()),
        );
        dictionary.delete("");
        await this.settings.update({ dictionary: [...dictionary].sort(cmpIgnoreCase) });

        // Network requests should not delay starting Obsidian
        this.app.workspace.onLayoutReady(() => {
            this.settingTab.load().catch(e => console.error(e));
            this.syncDictionary().catch(e => console.error(e));
            this.checkShownNote();
        });
        // A note is checked when it is first shown in an editor: when it is opened, when its
        // tab is selected, or when it is switched from reading view to editing view
        this.registerEvent(this.app.workspace.on("file-open", () => this.checkShownNote()));
        this.registerEvent(
            this.app.workspace.on("active-leaf-change", () => this.checkShownNote()),
        );
        this.registerEvent(this.app.workspace.on("layout-change", () => this.checkShownNote()));
    }

    /// The note each editor has checked as a whole since it showed it
    private checkedNotes = new WeakMap<EditorView, string>();

    /** With automatic checking, check the note in the active editor if it has not been yet */
    private checkShownNote() {
        // The editor shows the note, and its mode, only after the event
        window.setTimeout(() => {
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            const file = view?.file;
            if (!view || !file || view.getMode() !== "source") return;
            const settings = this.getFileSettings(file);
            if (!settings.shouldAutoCheck || !settings.checkOnOpen) return;
            // @ts-expect-error, not typed
            const editor = view.editor.cm as EditorView;
            // Already checked, e.g. when returning to its tab; edits are checked as they are made
            if (this.checkedNotes.get(editor) === file.path) return;
            this.checkedNotes.set(editor, file.path);
            this.runDetection(editor, true).catch(e => {
                this.checkedNotes.delete(editor);
                this.autoCheckFailed(e);
            });
        }, 100);
    }

    /** Report a failed automatic check, at most every 15 minutes */
    public autoCheckFailed(e: unknown) {
        console.error("Auto-check failed", e);
        if (Date.now() > this.autoCheckSuppressErrorsUntil) {
            this.autoCheckSuppressErrorsUntil = Date.now() + 15 * 60_000;
            new Notice("Auto-check failed:\n" + errorMessage(e), 10000);
        }
    }

    public onunload() {
        this.logs = [];
        this.runningChecks = 0;
        this.synonymEngine?.stop();
    }

    // Configure frontmatter suggestions
    public injectProperties(inject: boolean) {
        const properties = {
            "lt-language": "text",
            "lt-preferredLanguages": "multitext",
            "lt-picky": "checkbox",
            "lt-autoCheck": "checkbox",
            "lt-dictionary": "multitext",
            "lt-disabledRules": "multitext",
            "lt-disabledCategories": "multitext",
        };
        try {
            // WARNING: Internal API
            type MetadataTypeManager = {
                setType: (key: string, type: string) => void;
                unsetType: (key: string) => void;
            };
            // @ts-expect-error, not typed
            let typeManager = (this.app as { metadataTypeManager: MetadataTypeManager })
                .metadataTypeManager;
            for (const [key, type] of Object.entries(properties)) {
                if (inject) typeManager.setType(key, type);
                else typeManager.unsetType(key);
            }
        } catch {
            console.error("Failed to set metadata types");
        }
    }

    private registerCommands() {
        this.addCommand({
            id: "check",
            name: "Check text",
            icon: "spell-check",
            editorCallback: (editor, view) => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                this.runDetection(editorView).then(
                    suggestions => {
                        if (!suggestions) new Notice("No suggestions found.");
                    },
                    e => console.error(e),
                );
            },
        });
        this.addCommand({
            id: "toggle-auto-check",
            name: "Toggle automatic checking",
            icon: "uppercase-lowercase-a",
            callback: async () => {
                await this.settings.update({
                    shouldAutoCheck: !this.settings.options.shouldAutoCheck,
                });
            },
        });
        this.addCommand({
            id: "clear",
            name: "Clear suggestions",
            icon: "cross",
            editorCallback: editor => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                editorView.dispatch({ effects: [clearAllUnderlines.of(null)] });
            },
        });
        this.addCommand({
            id: "accept-all",
            name: "Accept all suggestions",
            icon: "circle-check-big",
            editorCallback: editor => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                let accepted: { from: number; to: number; change: ChangeSpec[] }[] = [];
                editorView.state
                    .field(underlineDecoration)
                    .between(0, Infinity, (from, to, value) => {
                        let underline = (value.spec as { underline?: api.LTLint }).underline;
                        // Suggestions that would break the formatting are left for the user
                        const change = underline && suggestionChange(underline, { from, to }, 0);
                        if (change) accepted.push({ from, to, change });
                    });
                // Overlapping suggestions cannot all be applied; the others stay underlined
                accepted = nonOverlapping(accepted);
                editorView.dispatch({
                    changes: accepted.flatMap(a => a.change),
                    effects: accepted.map(({ from, to }) =>
                        clearUnderlinesInRange.of({ from, to }),
                    ),
                });
            },
        });
        this.addCommand({
            id: "next",
            name: "Jump to next suggestion",
            icon: "chevron-right",
            editorCheckCallback: (checking, editor) => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                const cursorOffset = editor.posToOffset(editor.getCursor());
                let firstMatch = null as { from: number; to: number } | null;
                editorView.state
                    .field(underlineDecoration)
                    .between(cursorOffset + 1, Infinity, (from, to) => {
                        if (!firstMatch || firstMatch.from > from) {
                            firstMatch = { from, to };
                        }
                    });
                if (checking) {
                    return firstMatch != null;
                }
                if (firstMatch != null) {
                    editorView.dispatch({
                        selection: { anchor: firstMatch.from, head: firstMatch.to },
                    });
                }
            },
        });
        for (let i = 1; i <= SUGGESTIONS; i++) {
            this.addCommand(this.applySuggestionCommand(i));
        }
        this.addCommand({
            id: "synonyms",
            name: "Show synonyms",
            icon: "square-stack",
            editorCheckCallback: (checking, editor) => this.showSynonyms(editor, checking),
        });

        this.addCommand({
            id: "add-dict",
            name: "Add to dictionary",
            icon: "book-check",
            editorCheckCallback: (checking, editor) => {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;

                let match = singleMatchAtCursor(editor, 0);
                if (!match || !isSpelling(match.categoryId, match.ruleId))
                    return checking ? false : undefined;
                if (checking) return true;

                this.addToDictionary(match.text, editorView).catch(e => console.error(e));
            },
        });
    }

    private applySuggestionCommand(n: number): Command {
        return {
            id: `accept-${n}`,
            name: `Accept suggestion ${n}`,
            icon: "circle-check",
            editorCheckCallback(checking, editor) {
                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;

                let match = singleMatchAtCursor(editor, n);
                const change = match && suggestionChange(match, match.range, n - 1);
                if (!match || !change) return checking ? false : undefined;
                if (checking) return true;

                // Insert the text of the match
                editorView.dispatch({
                    changes: [change],
                    effects: [clearUnderlinesInRange.of(match.range)],
                });
            },
        };
    }

    private registerMenuItems() {
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, editor, view) => {
                console.debug(menu);

                // @ts-expect-error, not typed
                const editorView = editor.cm as EditorView;
                this.populateSuggestionMenu(menu, editorView);

                if (this.showSynonyms(editor, true)) {
                    menu.addItem(item => {
                        item.setTitle("Synonyms");
                        item.setIcon("square-stack");
                        item.setSection("spellcheck");
                        item.onClick(() => this.showSynonyms(editor));
                    });
                }
            }),
        );
    }

    private populateSuggestionMenu(menu: Menu, editor: EditorView): boolean {
        const underlines = editor.state.field(underlineDecoration);
        const selection = editor.state.selection.main;

        let populated = false;
        const cursor = underlines.iter(selection.from);
        while (cursor.value != null && cursor.from <= selection.to) {
            populated = true;
            const match = (cursor.value.spec as { underline: api.LTMatch }).underline;
            menu.addItem(item => {
                item.setTitle(`LanguageTool (${match.text})`);
                item.setIcon("spell-check");
                item.setSection("spellcheck");
                // @ts-expect-error, not typed
                const submenu = (item as { setSubmenu: () => Menu }).setSubmenu();
                // Copy the range, as the cursor moves on before a menu item is clicked
                this.populateSuggestionSubmenu(
                    submenu,
                    match,
                    { from: cursor.from, to: cursor.to },
                    editor,
                );
            });
            cursor.next();
        }
        return populated;
    }

    public populateSuggestionSubmenu(
        submenu: Menu,
        match: api.LTMatch,
        range: api.LTRange,
        editor: EditorView,
    ): void {
        if (match.message || match.title) {
            submenu.addItem(item => {
                let title = new DocumentFragment();
                title.appendChild(
                    createDiv({ cls: "lt-menu-info" }, header => {
                        if (match.title)
                            header.createDiv({ text: match.title, cls: "lt-menu-title" });
                        if (match.message)
                            header.createDiv({ text: match.message, cls: "lt-menu-message" });
                    }),
                );
                item.setIsLabel(true);
                item.setTitle(title);
            });
            submenu.addSeparator();
        }

        match.replacements.slice(0, SUGGESTIONS).forEach((replacement, index) => {
            const change = suggestionChange(match, range, index);
            submenu.addItem(item => {
                item.setTitle(replacement ? JSON.stringify(replacement) : "(delete)");
                // Applying it would remove markup, e.g. an emphasis marker or a link
                if (!change) return item.setDisabled(true);
                item.onClick(() => {
                    editor.dispatch({
                        changes: change,
                        effects: [clearUnderlinesInRange.of(range)],
                    });
                });
            });
        });

        submenu.addSeparator();

        if (isSpelling(match.categoryId, match.ruleId)) {
            submenu.addItem(subItem => {
                subItem.setTitle("Add to dictionary");
                subItem.setIcon("plus-with-circle");
                subItem.onClick(() => {
                    this.addToDictionary(match.text, editor).catch(e => console.error(e));
                });
            });
        } else {
            submenu.addItem(subItem => {
                subItem.setTitle("Ignore suggestion");
                subItem.setIcon("cross");
                subItem.onClick(() => {
                    editor.dispatch({ effects: [clearUnderlinesInRange.of(range)] });
                });
            });

            if (match.ruleId && match.ruleId !== "SYNONYMS") {
                submenu.addItem(subItem => {
                    subItem.setTitle("Disable rule");
                    subItem.setIcon("circle-off");
                    subItem.onClick(() => {
                        this.disableRule(match.ruleId, editor).catch(e => console.error(e));
                    });

                    // @ts-expect-error, not typed
                    const dom = subItem.dom as HTMLElement;
                    setTooltip(dom, `${match.categoryId} > ${match.ruleId}`);
                });
            }
        }
    }

    private showSynonyms(editor: Editor, checking: boolean = false): boolean {
        const choice = this.settings.options.synonyms;
        if (!choice || (choice !== "auto" && !(choice in api.SYNONYMS))) return false;

        // @ts-expect-error, not typed
        const editorView = editor.cm as EditorView;
        const selection = editorView.state.selection.main;
        if (selection.empty) return false;

        const word = editorView.state.sliceDoc(
            editorView.state.selection.main.from,
            editorView.state.selection.main.to,
        );
        if (word.match(/[\s.]/)) return false;

        if (checking) return true;

        const line = editorView.state.doc.lineAt(selection.from);

        const prefix = line.text.slice(0, selection.from - line.from).lastIndexOf(".") + 1;
        const sentence_raw = line.text.slice(prefix);
        let sentence = sentence_raw.trimStart();
        const offset = line.from + prefix + sentence_raw.length - sentence.length;
        const sel = { from: selection.from - offset, to: selection.to - offset };

        sentence = sentence.trimEnd();
        const suffix = sentence.indexOf(".");
        if (suffix !== -1) sentence = sentence.slice(0, suffix + 1);

        const range = { from: selection.from, to: selection.to };
        this.lookUpSynonyms(editorView, word, range, sentence, sel, line.text).catch(e => {
            const err = e as Error;
            console.error(err);
            this.pushLogs(err);
            new Notice(err.message, 30000);
        });
        return true;
    }

    /**
     * Find the synonyms of a word in the language of its paragraph and open them under it,
     * one row per meaning
     */
    private async lookUpSynonyms(
        view: EditorView,
        word: string,
        range: api.LTRange,
        sentence: string,
        selection: api.LTRange,
        paragraph: string,
    ) {
        const options = this.getFileSettings(this.app.workspace.getActiveFile());
        const language =
            options.synonyms === "auto"
                ? await api.detectLanguage(options, this.settings.getApiKey(), paragraph)
                : options.synonyms;
        const synonyms = api.SYNONYMS[language];
        if (!synonyms) {
            new Notice(`There are no synonyms for ${languageName(language)}.`);
            return;
        }
        const groups = (await this.querySynonyms(synonyms, sentence, selection)).filter(
            group => group.length,
        );
        // The word may have changed while the synonyms were on their way
        if (view.state.sliceDoc(range.from, range.to) !== word) return;
        if (!groups.length) {
            new Notice(`No synonyms found for "${word}".`);
            return;
        }
        const all = groups.flat();
        const lint: api.LTLint = {
            text: word,
            range,
            title: "Synonyms",
            message: "",
            categoryId: "SYNONYMS",
            ruleId: "SYNONYMS",
            language,
            replacements: all.map(s => s.term),
            notes: all.map(s => s.note ?? null),
            groups: groups.map(group => group.length),
        };
        view.dispatch({ effects: [addUnderline.of(lint)] });
        // Open them at once, as if the new underline had been clicked
        view.dispatch({ effects: [openSuggestions(lint)] });
    }

    /** Ask a synonym service; the local engine is started first, and restarted once if it fails */
    private async querySynonyms(
        synonyms: api.SynonymApi,
        sentence: string,
        selection: api.LTRange,
    ): Promise<api.Synonym[][]> {
        const engine = this.synonymEngine;
        if (!synonyms.local || !engine) return synonyms.query(sentence, selection, "");
        try {
            return await synonyms.query(sentence, selection, await engine.url());
        } catch {
            engine.stop();
            return synonyms.query(sentence, selection, await engine.url());
        }
    }

    /** Mark a check as finished; the status bar shows ready once no other check is running */
    public setStatusBarReady() {
        this.runningChecks = Math.max(0, this.runningChecks - 1);
        if (this.runningChecks === 0 && this.statusBarItem)
            setIcon(this.statusBarItem, "spell-check");
    }

    /** Mark a check as started */
    public setStatusBarWorking() {
        this.runningChecks += 1;
        if (this.runningChecks === 1 && this.statusBarItem)
            setIcon(this.statusBarItem, "sync-small");
    }

    private handleStatusBarClick() {
        if (!this.statusBarItem) return;

        const statusBarRect = this.statusBarItem.getBoundingClientRect();
        const statusBarIconRect = this.statusBarItem.getBoundingClientRect();

        new Menu()
            .addItem(item => {
                item.setTitle("Check text");
                item.setIcon("spell-check");
                item.onClick(async () => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (view && view.getMode() === "source") {
                        // @ts-expect-error, not typed
                        const editorView = view.editor.cm as EditorView;
                        const suggestions = await this.runDetection(editorView);
                        if (!suggestions) new Notice("No suggestions found.");
                    }
                });
            })
            .addItem(item => {
                item.setTitle(
                    this.settings.options.shouldAutoCheck
                        ? "Disable automatic checking"
                        : "Enable automatic checking",
                );
                item.setIcon("uppercase-lowercase-a");
                item.onClick(async () => {
                    await this.settings.update({
                        shouldAutoCheck: !this.settings.options.shouldAutoCheck,
                    });
                });
            })
            .addItem(item => {
                item.setTitle("Clear suggestions");
                item.setIcon("cross");
                item.onClick(() => {
                    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                    if (!view) return;

                    // @ts-expect-error, not typed
                    const editorView = view.editor.cm as EditorView;
                    editorView.dispatch({ effects: [clearAllUnderlines.of(null)] });
                });
            })
            .showAtPosition({ x: statusBarIconRect.right + 5, y: (statusBarRect?.top || 0) - 5 });
    }

    /** The file shown in an editor, which is not always the active file (e.g. in a hover popover) */
    public editorFile(editor: EditorView): TFile | null {
        return (
            editor.state.field(editorInfoField, false)?.file ?? this.app.workspace.getActiveFile()
        );
    }

    /**
     * Get the settings for a file, where values might be reconfigured in the frontmatter.
     */
    public getFileSettings(file: TFile | null): Readonly<LTOptions> {
        const cache = file && this.app.metadataCache.getFileCache(file);
        return applyNoteSettings(this.settings.options, cache?.frontmatter);
    }

    /** Add a word to the dictionary and remove its underlines */
    public async addToDictionary(word: string, editor?: EditorView): Promise<void> {
        const text = word.trim();
        if (!text) return;
        const dictionary = new Set(this.settings.options.dictionary);
        dictionary.add(text);
        await this.settings.update({ dictionary: [...dictionary].sort(cmpIgnoreCase) });
        editor?.dispatch({ effects: [clearMatchingUnderlines.of(m => m.text.trim() === text)] });
        await this.syncDictionary();
    }

    /** Disable a rule and remove its underlines */
    public async disableRule(ruleId: string, editor?: EditorView): Promise<void> {
        const disabledRules = new Set(this.settings.options.disabledRules);
        disabledRules.add(ruleId);
        await this.settings.update({ disabledRules: [...disabledRules].sort(cmpIgnoreCase) });
        editor?.dispatch({ effects: [clearMatchingUnderlines.of(m => m.ruleId === ruleId)] });
    }

    /**
     * Check the current document, adding underlines.
     */
    public async runDetection(
        editor: EditorView,
        auto: boolean = false,
        range?: api.LTRange,
    ): Promise<boolean> {
        let settings = this.getFileSettings(this.editorFile(editor));

        const selection = editor.state.selection.main;
        if (!range && !selection.empty) range = { ...selection };

        const text = editor.state.sliceDoc(); // handles line endings
        if (!text.trim()) return false;

        // Edits made during the check move its results, or make them outdated
        const tracker = new ChangeTracker(editor);
        let found = 0;
        let longNotice: Notice | undefined = undefined;
        try {
            this.setStatusBarWorking();

            const syntax = new markdown.SyntaxTree(text);

            let { offset, annotations } = syntax.annotate(range);
            // reduce request size
            offset += annotations.optimize();
            if (annotations.length() === 0) return false;
            // Notification for mobile devices, that do not have the status bar indicator
            if (settings.longCheckNotification && !auto && annotations.plainLength() > 500)
                longNotice = new Notice("Checking spelling...", 30000);

            const { requests, parallel } = api.planRequests(settings, offset, annotations);
            console.debug(
                `Checking ${annotations.plainLength()} characters in ${requests.length} requests...`,
            );

            // The previous underlines of the checked text go; the new ones are shown as each
            // request returns, so a long note shows its first suggestions quickly
            editor.dispatch({
                effects: range
                    ? clearUnderlinesInRange.of({ from: offset, to: offset + annotations.length() })
                    : clearAllUnderlines.of(null),
            });

            const apiKey = this.settings.getApiKey();
            for (let i = 0; i < requests.length; i += parallel) {
                const batch = requests.slice(i, i + parallel);
                const results = await Promise.all(
                    batch.map(r => api.check(settings, apiKey, r.offset, r.text, text)),
                );
                // The editor opened another note meanwhile, which gets its own check
                if (tracker.replaced()) break;
                const effects: StateEffect<api.LTLint>[] = [];
                batch.forEach((request, k) => {
                    // Text edited in the meantime is checked again by the automatic check
                    const checked = {
                        from: request.offset,
                        to: request.offset + request.text.length(),
                    };
                    if (tracker.edited(checked)) return;
                    for (const match of results[k]) {
                        if (this.ignored(match, settings, syntax)) continue;
                        effects.push(
                            addUnderline.of({ ...match, range: tracker.map(match.range) }),
                        );
                    }
                });
                if (effects.length) editor.dispatch({ effects });
                found += effects.length;
            }
        } catch (e) {
            console.error(e);
            if (e instanceof Error) {
                this.pushLogs(e);
                if (!auto) new Notice(e.message, 30000);
            }
            if (auto) throw e; // re-throw for auto-checks
            return true;
        } finally {
            tracker.stop();
            this.setStatusBarReady();
            if (longNotice) longNotice.hide();
        }

        console.debug(`Found ${found} suggestions.`);
        // reset auto-check disable on successful check
        this.autoCheckSuppressErrorsUntil = 0;
        return found > 0;
    }

    /** Whether a match is not shown: a word in the dictionary, or whitespace in a table */
    private ignored(
        match: api.LTLint,
        settings: Readonly<LTOptions>,
        syntax: markdown.SyntaxTree,
    ): boolean {
        if (
            isSpelling(match.categoryId, match.ruleId) &&
            settings.dictionary.includes(match.text.trim())
        )
            return true;
        // LanguageTool's whitespace in tables is the markup that draws the table
        return (
            match.categoryId === "WHITESPACE" &&
            (syntax.isInside(match.range.from, "table") || syntax.isInside(match.range.to, "table"))
        );
    }

    /**
     * Add an error to the log.
     */
    private pushLogs(e: Error) {
        const debugString =
            `${new Date().toLocaleString()}:\n` +
            `Error: '${e.message}'\n` +
            `Settings: ${JSON.stringify({ ...this.settings.options, username: "REDACTED", apikey: "REDACTED" })}\n`;

        this.logs.push(debugString);
        if (this.logs.length > 10) this.logs.shift();
    }

    public async onExternalSettingsChange() {
        const serverUrl = this.settings.options.serverUrl;
        await this.settings.load();
        if (this.settings.options.serverUrl !== serverUrl) this.settingTab.reloadLanguages();
        else this.settingTab.update();
    }

    /**
     * Synchronizes with the LanguageTool dictionary,
     * returning whether the local dictionary has been changed.
     */
    public async syncDictionary(): Promise<void> {
        if (
            !this.settings.options.syncDictionary ||
            endpointFromUrl(this.settings.options.serverUrl) !== "premium"
        ) {
            // Nothing to do
            return;
        }

        try {
            const lastWords = new Set(this.settings.options.remoteDictionary);
            let localWords = new Set(this.settings.options.dictionary);
            let remoteWords = new Set(
                await api.words(this.settings.options, this.settings.getApiKey()),
            );

            // words that have been removed locally
            let localRemoved = setDifference(lastWords, localWords);
            localRemoved = setIntersect(localRemoved, remoteWords);
            for (const word of localRemoved) {
                await api.wordsDel(this.settings.options, this.settings.getApiKey(), word);
            }

            // words that have been removed remotely
            const remoteRemoved = setDifference(lastWords, remoteWords);

            remoteWords = setDifference(remoteWords, localRemoved);
            localWords = setDifference(localWords, remoteRemoved);

            // words that have been added locally
            const missingRemote = setDifference(localWords, remoteWords);
            for (const word of missingRemote) {
                await api.wordsAdd(this.settings.options, this.settings.getApiKey(), word);
            }

            // merge remaining words
            const words = setUnion(remoteWords, localWords);
            let dictionary = [...words].sort(cmpIgnoreCase);
            await this.settings.update({ dictionary, remoteDictionary: dictionary });
        } catch (e) {
            const err = e as Error;
            this.pushLogs(err);
            new Notice(err.message, 30000);
            console.error("Failed sync spellcheck with LanguageTool", e);
        }
    }
}

function singleMatchAtCursor(editor: Editor, minReplacements: number = 1): api.LTLint | undefined {
    // @ts-expect-error, not typed
    const editorView = editor.cm as EditorView;
    const cursorOffset = editor.posToOffset(editor.getCursor());

    const matches: api.LTLint[] = [];

    // Get underline-matches at cursor
    editorView.state
        .field(underlineDecoration)
        .between(cursorOffset, cursorOffset, (from, to, value) => {
            let match = (value.spec as { underline?: api.LTMatch }).underline;
            if (match) matches.push({ ...match, range: { from, to } });
        });

    // Check that there is exactly one match that has a replacement in the slot that is called.
    if (!matches || matches.length !== 1) return undefined;
    const underline = matches[0];
    const preconditions = underline && underline.replacements.length >= minReplacements;
    return preconditions ? underline : undefined;
}

/** «es» → «Spanish» */
function languageName(code: string): string {
    try {
        return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
    } catch {
        return code;
    }
}
