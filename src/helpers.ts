export type CategoryClass = "lt-minor" | "lt-style" | "lt-major";

/** Whether a match is a spelling error, which the dictionary can ignore */
export function isSpelling(categoryId: string, ruleId: string): boolean {
    return (
        categoryId === "TYPOS" ||
        // Newer form of spelling errors (probably using LLMs in the backend)
        ruleId.includes("SPELLING") ||
        (ruleId.startsWith("QB_NEW_EN_") && ruleId.includes("ORTHOGRAPHY"))
    );
}

// Assign a CSS class based on a rule's category ID
export function categoryCssClass(categoryId: string, ruleId: string): CategoryClass {
    if (isSpelling(categoryId, ruleId)) return "lt-major";

    switch (categoryId) {
        case "COLLOQUIALISMS":
        case "REDUNDANCY":
        case "STYLE":
        case "SYNONYMS":
            return "lt-style";
        default:
            return "lt-minor";
    }
}

/** Keep only changes that do not overlap an earlier one, as overlapping replacements corrupt the text */
export function nonOverlapping<T extends { from: number; to: number }>(changes: T[]): T[] {
    const result: T[] = [];
    let end = -1;
    for (const change of [...changes].sort((a, b) => a.from - b.from || a.to - b.to)) {
        if (change.from < end || (change.from === end && result.at(-1)?.from === change.from))
            continue;
        result.push(change);
        end = Math.max(end, change.to);
    }
    return result;
}

export function setDifference<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const difference = new Set(setA);
    for (const elem of setB) {
        difference.delete(elem);
    }
    return difference;
}
export function setUnion<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const union = new Set(setA);
    for (const elem of setB) {
        union.add(elem);
    }
    return union;
}
export function setIntersect<T>(setA: Set<T>, setB: Set<T>): Set<T> {
    const intersection = new Set<T>();
    for (const elem of setB) {
        if (setA.has(elem)) {
            intersection.add(elem);
        }
    }
    return intersection;
}

export function cmpIgnoreCase(a: string, b: string): number {
    return a.localeCompare(b, undefined, { sensitivity: "base" }) || a.localeCompare(b);
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
