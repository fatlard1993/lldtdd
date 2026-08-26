// Fixture for the document-level lifecycle contract. `marks` records which hooks ran, so a claim can
// tell an inherited default from a group's own override by what the subject observed.
export let marks: string[] = [];

export function docReset(): void { marks.push("doc"); }
export function groupReset(): void { marks.push("group"); }

/** True when the most recent hook to run was the document default. */
export function ranDocDefault(): boolean { return marks[marks.length - 1] === "doc"; }

/** True when the most recent hook to run was the group's own. */
export function ranGroupOverride(): boolean { return marks[marks.length - 1] === "group"; }
