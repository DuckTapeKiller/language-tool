import { EditorView, Tooltip, ViewPlugin, keymap, showTooltip, tooltips } from "@codemirror/view";
import { EditorState, Extension, StateEffect, StateField } from "@codemirror/state";
import { categoryCssClass, isSpelling, nonOverlapping, suggestionChange } from "../helpers";
import { ButtonComponent, setIcon } from "obsidian";
import { default as LanguageToolPlugin } from "../main";
import { clearUnderlinesInRange, underlineDecoration } from "./underlines";
import * as api from "../api";
import { SUGGESTIONS } from "../settings";

/// Class of the element around the suggestions tooltip
const TOOLTIP_HOST = "lt-tooltip-host";
/// How long the mouse rests on an underline, or away from it, before the tooltip opens or closes
const HOVER_TIME = 300;

/// Rules whose matches can all be fixed at once: the plugin's own, except the one with two fixes
const FIX_ALL = /^RAE_(?!COMILLAS_Y_CURSIVA$)/;

/** The first suggestion of every underline of a rule in the note, without overlaps */
type Fix = { from: number; to: number; change: { from: number; to: number; insert: string }[] };

/** For every underline that `pick` accepts, the change of the suggestion it returns, without overlaps */
function changesFor(view: EditorView, pick: (underline: api.LTLint) => string | undefined): Fix[] {
    const found: Fix[] = [];
    view.state.field(underlineDecoration).between(0, view.state.doc.length, (from, to, value) => {
        const underline = (value.spec as { underline?: api.LTLint }).underline;
        const replacement = underline && pick(underline);
        if (replacement === undefined) return;
        // Each underline applies its own edit for that suggestion, which keeps its formatting
        const index = underline!.replacements.indexOf(replacement);
        const change = index < 0 ? null : suggestionChange(underline!, { from, to }, index);
        if (change) found.push({ from, to, change });
    });
    return nonOverlapping(found);
}

function createTooltip(
    plugin: LanguageToolPlugin,
    view: EditorView,
    match: api.LTMatch,
    range: api.LTRange,
): HTMLElement {
    const replacements = match.replacements.slice(0, SUGGESTIONS / 2);
    const category = match.categoryId;
    const ruleId = match.ruleId;
    const categoryClass = categoryCssClass(category, ruleId);

    return createDiv({ cls: ["lt-tooltip", categoryClass] }, root => {
        if (match.title) root.createSpan({ cls: "lt-title", text: match.title });
        if (match.message) root.createSpan({ cls: "lt-message", text: match.message });

        root.createDiv({ cls: "lt-bottom" }, bottom => {
            bottom.createDiv({ cls: "lt-buttoncontainer" }, container => {
                replacements.forEach((btnText, index) => {
                    const button = new ButtonComponent(container);
                    button.setButtonText(btnText || "(delete)");
                    const change = suggestionChange(match, range, index);
                    if (!change) {
                        // Applying it would remove markup, e.g. an emphasis marker or a link
                        button.setDisabled(true);
                        button.setTooltip("Would change the formatting, edit it by hand");
                        return;
                    }
                    button.onClick(() => {
                        view.dispatch({
                            changes: change,
                            effects: [clearUnderlinesInRange.of(range)],
                        });
                        // The button took the focus; give it back, so typing and undo work
                        view.focus();
                    });
                });
            });
        });

        // The plugin's own rules have one mechanical fix, so all of them can be applied
        // at once, e.g. every “cita” to «cita». The same misspelled word, wherever it
        // occurs, can take the same correction: every «errorr» to «error».
        const first = match.replacements[0];
        let all: Fix[] = [];
        let label = "";
        if (FIX_ALL.test(ruleId)) {
            all = changesFor(view, u => (u.ruleId === ruleId ? u.replacements[0] : undefined));
            label = `Fix all ${all.length} in this note`;
        } else if (isSpelling(category, ruleId) && first !== undefined && match.text) {
            all = changesFor(view, u =>
                u.text === match.text && isSpelling(u.categoryId, u.ruleId) ? first : undefined,
            );
            label = `Change all ${all.length} to "${first}"`;
        }
        if (all.length > 1) {
            root.createDiv({ cls: "lt-fix-all-row" }, row => {
                row.createDiv({ cls: "lt-fix-all" }, button => {
                    setIcon(button.createSpan(), "check-check");
                    button.createSpan({ text: label });
                    button.onclick = () => {
                        view.dispatch({
                            changes: all.flatMap(c => c.change),
                            effects: all.map(({ from, to }) =>
                                clearUnderlinesInRange.of({ from, to }),
                            ),
                        });
                        view.focus();
                    };
                });
            });
        }

        root.createDiv({ cls: "lt-ignore-container" }, container => {
            if (isSpelling(category, ruleId)) {
                container.createDiv({ cls: "lt-ignore-btn" }, button => {
                    setIcon(button.createSpan(), "plus-with-circle");
                    button.createSpan({ text: "Add to dictionary" });
                    button.onclick = () => {
                        // Add to global dictionary, removing other underlines with the same word
                        plugin.addToDictionary(match.text, view).catch(e => console.error(e));
                        view.focus();
                    };
                });
            } else {
                container.createDiv({ cls: "lt-ignore-btn" }, button => {
                    setIcon(button.createSpan(), "cross");
                    button.createSpan({ text: "Ignore" });
                    button.onclick = () => {
                        view.dispatch({ effects: [clearUnderlinesInRange.of(range)] });
                        view.focus();
                    };
                });
                if (category !== "SYNONYMS") {
                    container.createDiv({ cls: "lt-ignore-btn" }, button => {
                        setIcon(button.createSpan(), "circle-off");
                        button.createSpan({ text: "Disable rule" });
                        button.onclick = () => {
                            // Remove other underlines of the same rule
                            plugin.disableRule(ruleId, view).catch(e => console.error(e));
                            view.focus();
                        };
                    });
                }
            }
            container.createDiv({ cls: "lt-info-container" }, container => {
                container.createDiv({ cls: "lt-info-button clickable-icon" }, button => {
                    setIcon(button, "info");
                    button.onclick = () => {
                        const popup = root.querySelector(".lt-info-box");
                        if (popup) popup.toggleAttribute("hidden");
                    };
                });
            });
        });
        root.createDiv({ cls: "lt-info-box", attr: { hidden: true } }, popup => {
            // \u00A0 is a non-breaking space
            popup.createDiv({ cls: "lt-info", text: `Category:\u00A0${category}` });
            popup.createDiv({ cls: "lt-info", text: `Rule:\u00A0${ruleId}` });
            popup.createDiv({
                cls: "lt-info",
                text: `Text:\u00A0${match.text} (${range.from}-${range.to})`,
            });
        });
    });
}

/** The underline at a position, if any */
function underlineAt(
    state: EditorState,
    pos: number,
): { match: api.LTLint; range: api.LTRange } | null {
    const underlines = state.field(underlineDecoration);
    if (underlines.size === 0) return null;
    // The innermost one, e.g. a misspelling inside a quotation whose marks are underlined too
    let found: { match: api.LTLint; range: api.LTRange } | null = null;
    underlines.between(pos, pos, (from, to, value) => {
        if (!found || to - from < found.range.to - found.range.from)
            found = {
                match: (value.spec as { underline: api.LTLint }).underline,
                range: { from, to },
            };
    });
    return found;
}

interface OpenTooltip {
    tooltip: Tooltip;
    range: api.LTRange;
    /// Opened by clicking, which keeps it open while the cursor stays on the underline
    byClick: boolean;
}

function openTooltip(
    plugin: LanguageToolPlugin,
    match: api.LTLint,
    range: api.LTRange,
    byClick: boolean,
): OpenTooltip {
    const tooltip: Tooltip = {
        pos: range.from,
        end: range.to,
        above: true,
        strictSide: false,
        arrow: false,
        clip: false,
        create: view => {
            const host = createDiv({ cls: TOOLTIP_HOST });
            host.appendChild(createTooltip(plugin, view, match, range));
            // Moving the mouse onto the tooltip keeps it open
            host.addEventListener("mouseenter", () => view.plugin(hoverListener)?.cancelClose());
            host.addEventListener("mouseleave", () => view.plugin(hoverListener)?.scheduleClose());
            return { dom: host };
        },
    };
    return { tooltip, range, byClick };
}

const showSuggestions = StateEffect.define<{ match: api.LTLint; range: api.LTRange }>();
const hideSuggestions = StateEffect.define<null>();

/** Field holding the open suggestions tooltip; created per plugin instance */
let suggestionsField: StateField<OpenTooltip | null> | null = null;

/**
 * Opens the suggestions of an underline once the mouse has rested on it.
 * CodeMirror's own hover tooltips sometimes never open after scrolling,
 * so this works on the underline elements under the mouse instead.
 */
const hoverListener = ViewPlugin.fromClass(
    class {
        openTimer = -1;
        closeTimer = -1;
        pending: number | null = null;

        constructor(readonly view: EditorView) {}

        open(): OpenTooltip | null {
            return suggestionsField
                ? (this.view.state.field(suggestionsField, false) ?? null)
                : null;
        }

        mousemove(event: MouseEvent) {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest(`.${TOOLTIP_HOST}`)) return this.cancelClose();
            if (!target?.closest(".lt-underline")) {
                this.cancelOpen();
                return this.scheduleClose();
            }
            const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
            const found = pos == null ? null : underlineAt(this.view.state, pos);
            if (!found) return;
            this.cancelClose();
            const open = this.open();
            if (open && open.range.from === found.range.from) return;
            if (this.pending === found.range.from) return;
            this.cancelOpen();
            this.pending = found.range.from;
            this.openTimer = window.setTimeout(() => {
                this.pending = null;
                // The underline may have changed in the meantime
                const now = underlineAt(this.view.state, found.range.from);
                if (
                    now &&
                    now.range.to === found.range.to &&
                    this.view.state.selection.ranges.length === 1
                )
                    this.view.dispatch({ effects: showSuggestions.of(now) });
            }, HOVER_TIME);
        }

        cancelOpen() {
            window.clearTimeout(this.openTimer);
            this.pending = null;
        }

        cancelClose() {
            window.clearTimeout(this.closeTimer);
        }

        /** Close a tooltip opened by hovering, unless the mouse comes back */
        scheduleClose() {
            window.clearTimeout(this.closeTimer);
            const open = this.open();
            if (!open || open.byClick) return;
            this.closeTimer = window.setTimeout(() => {
                const now = this.open();
                if (now && !now.byClick) this.view.dispatch({ effects: hideSuggestions.of(null) });
            }, HOVER_TIME);
        }

        destroy() {
            this.cancelOpen();
            this.cancelClose();
        }
    },
    {
        eventHandlers: {
            mousemove(event) {
                this.mousemove(event);
            },
            mouseleave() {
                this.cancelOpen();
                this.scheduleClose();
            },
        },
    },
);

/**
 * Suggestions open by clicking an underline, or by resting the mouse on it.
 * Escape closes them.
 */
function suggestions(plugin: LanguageToolPlugin): Extension {
    const field = StateField.define<OpenTooltip | null>({
        create: () => null,
        update(open, tr) {
            for (const e of tr.effects) {
                if (e.is(hideSuggestions)) open = null;
                if (e.is(showSuggestions))
                    open = openTooltip(plugin, e.value.match, e.value.range, false);
            }
            if (tr.docChanged) return null;
            const selection = tr.state.selection;
            if (tr.selection) {
                const found =
                    selection.ranges.length === 1 && selection.main.empty
                        ? underlineAt(tr.state, selection.main.head)
                        : null;
                if (tr.isUserEvent("select.pointer"))
                    return found ? openTooltip(plugin, found.match, found.range, true) : null;
                // Obsidian sets the selection again right after a click,
                // so keep the tooltip while the cursor stays on its underline
                if (open && found && found.range.from === open.range.from) return open;
                // Moving the cursor with the keyboard leaves a hovered tooltip alone
                return open && !open.byClick ? open : null;
            }
            // The underline may have been removed, e.g. by ignoring it
            if (open && !underlineAt(tr.state, open.range.from)) return null;
            return open;
        },
        provide: f => showTooltip.from(f, open => open?.tooltip ?? null),
    });
    suggestionsField = field;
    const escape = keymap.of([
        {
            key: "Escape",
            run: view => {
                if (!view.state.field(field)) return false;
                view.dispatch({ effects: hideSuggestions.of(null) });
                return true;
            },
        },
    ]);
    // Tooltips go where they fit in the visible editor, not in the whole window, where the
    // header of the tab would cover a tooltip shown above a line near the top
    const space = tooltips({ tooltipSpace: view => view.scrollDOM.getBoundingClientRect() });
    return [field, escape, hoverListener, space];
}

export function buildHoverTooltip(plugin: LanguageToolPlugin): Extension {
    return suggestions(plugin);
}

export const baseTheme = EditorView.baseTheme({
    [`.cm-tooltip.${TOOLTIP_HOST}`]: {
        padding: "var(--size-2-3)",
        border: "1px solid var(--background-modifier-border-hover)",
        backgroundColor: "var(--background-secondary)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-s)",
        zIndex: "var(--layer-menu)",
        userSelect: "none",
        overflow: "hidden",
        "& > .lt-tooltip": {
            fontFamily: "var(--default-font)",
            fontSize: "var(--font-ui-small)",
            width: "300px",
            lineHeight: 1.5,
            "& > .lt-title": {
                display: "block",
                fontWeight: 600,
                marginBottom: "6px",
                padding: "0 12px",
                textDecoration: "underline 2px var(--lt-highlight)",
                "-webkit-text-decoration": "underline 2px var(--lt-highlight)",
            },
            "& > .lt-message": { display: "block", padding: "0 12px" },
            "& > .lt-bottom": {
                minHeight: "10px",
                padding: "0 12px",
                position: "relative",
                "& > .lt-buttoncontainer": {
                    "&:not(:empty)": { paddingTop: "10px" },
                    "& > button": {
                        marginRight: "4px",
                        marginBottom: "4px",
                        padding: "4px 6px",
                        // Long suggestions wrap instead of being cut off
                        maxWidth: "100%",
                        height: "auto",
                        whiteSpace: "normal",
                        overflowWrap: "anywhere",
                        textAlign: "left",
                    },
                },
            },
            "& > .lt-fix-all-row": {
                padding: "0 12px 6px",
                "& > .lt-fix-all": {
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    fontSize: "var(--font-ui-small)",
                    lineHeight: 1,
                    cursor: "pointer",
                    color: "var(--text-accent)",
                    "& > span": { display: "flex" },
                    "&:hover": { color: "var(--text-accent-hover)" },
                },
            },
            "& > .lt-ignore-container": {
                display: "flex",
                "& > .lt-ignore-btn": {
                    fontSize: "var(--font-ui-small)",
                    padding: "4px",
                    display: "flex",
                    flex: 1,
                    width: "100%",
                    textAlign: "left",
                    alignItems: "center",
                    lineHeight: 1,
                    color: "var(--text-muted)",
                    "& > span": { display: "flex", "&:last-child": { marginLeft: "5px" } },
                    "&:hover": { color: "var(--text-normal)" },
                },
                "& > .lt-info-container": {
                    display: "flex",
                    flex: 0,
                    "& > .lt-info-button": { color: "var(--text-faint)", height: "100%" },
                },
            },
            "& > .lt-info-box": {
                padding: "5px 0px 0px 0px",
                overflowX: "scroll",
                color: "var(--text-muted)",
            },
        },
    },
    ".lt-underline": {
        cursor: "pointer",
        transition: "background-color 100ms ease-out",
        textDecoration: "wavy underline var(--lt-highlight)",
        "-webkit-text-decoration": "wavy underline var(--lt-highlight)",
        "&:hover": { backgroundColor: "color-mix(in srgb, var(--lt-highlight), transparent 80%)" },
    },
});
