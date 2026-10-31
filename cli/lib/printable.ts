// Text an agent wrote (a proxy log field, a commit subject) on its way to the
// developer's terminal: no control character (C0, DEL, C1), so no escape
// sequence either, which could move the cursor and erase or rewrite what
// forge printed before.
export const printable = (text: string): string => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
