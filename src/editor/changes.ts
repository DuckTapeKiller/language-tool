import { ChangeSet, Extension, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as api from "../api";

/**
 * The changes made to an editor's document since a check started. They move the results
 * of the check to the text they belong to, so that typing during a check does not discard
 * them, and show which parts were edited, whose results are outdated.
 */
export class ChangeTracker {
    private changes: ChangeSet;
    /// The document the changes lead to
    private doc: Text;

    constructor(private readonly view: EditorView) {
        this.doc = view.state.doc;
        this.changes = ChangeSet.empty(this.doc.length);
        let trackers = TRACKERS.get(view);
        if (!trackers) TRACKERS.set(view, (trackers = new Set()));
        trackers.add(this);
    }

    /** Add the changes of an update, which lead to `doc` */
    add(changes: ChangeSet, doc: Text = this.doc) {
        // Changes to another document, after the editor opened another note
        if (changes.length !== this.changes.newLength) return;
        this.changes = this.changes.compose(changes);
        this.doc = doc;
    }

    /**
     * Whether the editor shows another document than the checked one: opening another
     * note replaces its state at once, without changes to follow
     */
    replaced(): boolean {
        return this.view.state.doc !== this.doc;
    }

    /** Whether text in the range, in positions from when the check started, was edited */
    edited(range: api.LTRange): boolean {
        return this.changes.touchesRange(range.from, range.to) !== false;
    }

    /** The range in the current document */
    map(range: api.LTRange): api.LTRange {
        return { from: this.changes.mapPos(range.from, 1), to: this.changes.mapPos(range.to, -1) };
    }

    stop() {
        TRACKERS.get(this.view)?.delete(this);
    }
}

const TRACKERS = new WeakMap<EditorView, Set<ChangeTracker>>();

/** Feeds the changes of every editor to the checks running on it */
export const changeTracking: Extension = EditorView.updateListener.of(update => {
    if (!update.docChanged) return;
    for (const tracker of TRACKERS.get(update.view) ?? [])
        tracker.add(update.changes, update.state.doc);
});
