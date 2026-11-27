/** The templates of a new wiki page (Empty, Runbook, Decision record). `{{title}}` is the page name. No network. */

export interface WikiTemplate {
  key: "empty" | "runbook" | "decision";
  name: string;
  description: string;
  headings: string[];
  content: string;
}

export const WIKI_TEMPLATES: WikiTemplate[] = [
  { key: "empty", name: "Empty", description: "Just the title", headings: [], content: "# {{title}}\n" },
  {
    key: "runbook",
    name: "Runbook",
    description: "When to use · Steps · Rollback · Contacts",
    headings: ["When to use", "Steps", "Rollback", "Contacts"],
    content: "# {{title}}\n\n## When to use\nWhen does someone open this runbook?\n\n## Steps\n1. \n2. \n3. \n\n## Rollback\nHow do you undo it?\n\n## Contacts\nWho knows this, and who decides?\n",
  },
  {
    key: "decision",
    name: "Decision record",
    description: "Context · Decision · Consequences · Status",
    headings: ["Context", "Decision", "Consequences"],
    content: "# {{title}}\n\n## Context\nWhy does this need a decision?\n\n## Decision\nWhat do we do?\n\n## Consequences\nWhat does this mean for the team?\n\nStatus: proposed\nDeciders: \n",
  },
];

export function templateText(key: string | undefined, title: string): string {
  const t = WIKI_TEMPLATES.find((x) => x.key === (key ?? "empty").toLowerCase()) ?? null;
  if (!t) throw new Error(`unknown template '${key}': ${WIKI_TEMPLATES.map((x) => x.key).join(", ")}`);
  return t.content.replace(/\{\{title\}\}/g, title);
}
