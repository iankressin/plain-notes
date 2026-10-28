// A note may start with a frontmatter block between `---` lines; `pinned: true`
// in it pins the note (read by list_notes in lib.rs and by the MCP server).
// The editor only ever sees the body: the markdown converter would flatten the
// block into a paragraph, so it is split off on load and put back on save.

export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: '', body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return { frontmatter: '', body: text };
  return {
    frontmatter: lines.slice(0, end + 1).join('\n') + '\n',
    body: lines.slice(end + 1).join('\n'),
  };
}

export function isPinned(frontmatter: string): boolean {
  return frontmatter
    .split('\n')
    .some((l) => l.trim().startsWith('pinned:') && l.includes('true'));
}

/** `frontmatter` with the pinned flag set, or '' once nothing else is left in it. */
export function setPinned(frontmatter: string, pinned: boolean): string {
  const lines = frontmatter ? frontmatter.replace(/\n$/, '').split('\n') : ['---', '---'];
  const kept = lines.filter((l) => !l.trim().startsWith('pinned:'));
  // Right after the opening `---`: lib.rs only looks at the first few lines.
  if (pinned) kept.splice(1, 0, 'pinned: true');
  return kept.length > 2 ? kept.join('\n') + '\n' : '';
}
