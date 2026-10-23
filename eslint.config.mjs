import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
    {
        languageOptions: {
            parserOptions: {
                projectService: { allowDefaultProject: ["*.mjs", "manifest.json", "package.json"] },
                tsconfigRootDir: import.meta.dirname,
                extraFileExtensions: [".json"],
            },
        },
    },
    ...obsidianmd.configs.recommended,
    { files: ["**/*.mjs"], ...tseslint.configs.disableTypeChecked },
    // Only the committed bundle is excluded; everything else is linted
    globalIgnores(["node_modules", "main.js"]),
);
