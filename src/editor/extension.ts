import LanguageToolPlugin from "../main";
import { autoCheckListener } from "./autoCheck";
import { changeTracking } from "./changes";
import { underlineDecoration } from "./underlines";
import { Extension } from "@codemirror/state";
import { baseTheme, buildHoverTooltip } from "./tooltip";

export function underlineExtension(plugin: LanguageToolPlugin): Extension {
    return [
        underlineDecoration,
        changeTracking,
        autoCheckListener(plugin),
        buildHoverTooltip(plugin),
        baseTheme,
    ];
}
