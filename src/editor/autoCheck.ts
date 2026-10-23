import { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import LanguageToolPlugin from "../main";
import { Notice } from "obsidian";
import * as api from "../api";

const EMPTY: api.LTRange = { from: Infinity, to: -Infinity };

/** Grow a range to include another one */
function union(a: api.LTRange, b: api.LTRange): api.LTRange {
    return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
}

export function autoCheckListener(plugin: LanguageToolPlugin): Extension {
    // One instance per editor, so that edits in different notes do not interfere
    return ViewPlugin.fromClass(
        class {
            debounceTimer = -1;
            /// Edited range that has not been checked yet
            pending: api.LTRange = EMPTY;
            /// Range that is being checked, if any
            checking: api.LTRange | null = null;
            /// Whether the document changed while checking, which discards the results
            changedWhileChecking = false;
            destroyed = false;

            constructor(readonly view: EditorView) {}

            update(update: ViewUpdate) {
                if (!update.docChanged) return;

                // Keep the ranges pointing at the same text
                const map = (range: api.LTRange): api.LTRange =>
                    range.from > range.to
                        ? range
                        : {
                              from: update.changes.mapPos(range.from, -1),
                              to: update.changes.mapPos(range.to, 1),
                          };
                this.pending = map(this.pending);
                if (this.checking) {
                    this.checking = map(this.checking);
                    this.changedWhileChecking = true;
                }

                const settings = plugin.getFileSettings(plugin.editorFile(this.view));
                if (!settings.shouldAutoCheck) return;

                update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
                    this.pending = union(this.pending, { from: fromB, to: toB });
                });
                this.schedule();
            }

            schedule() {
                window.clearTimeout(this.debounceTimer);
                if (this.destroyed) return;
                this.debounceTimer = window.setTimeout(
                    () => this.run(),
                    plugin.settings.options.autoCheckDelay,
                );
            }

            run() {
                // Wait for the running check, its results might be discarded
                if (this.checking) return this.schedule();
                if (this.pending.from > this.pending.to) return;

                const range = this.pending;
                this.pending = EMPTY;
                this.checking = range;
                this.changedWhileChecking = false;

                plugin
                    .runDetection(this.view, true, range)
                    .then(
                        () => {
                            // The document changed during the check, so check the range again
                            if (this.changedWhileChecking && this.checking) {
                                this.pending = union(this.pending, this.checking);
                                this.schedule();
                            }
                        },
                        e => {
                            const error = e as Error;
                            if (Date.now() > plugin.autoCheckSuppressErrorsUntil) {
                                // Prevent spamming errors
                                plugin.autoCheckSuppressErrorsUntil = Date.now() + 15 * 60_000; // 15 minutes
                                new Notice("Auto-check failed:\n" + error.message, 10000);
                            }
                            console.error("Auto-check failed", e);
                        },
                    )
                    .finally(() => {
                        this.checking = null;
                    });
            }

            destroy() {
                this.destroyed = true;
                window.clearTimeout(this.debounceTimer);
            }
        },
    );
}
