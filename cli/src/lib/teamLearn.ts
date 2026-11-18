import { repoClient, type Ctx } from "./context.js";
import { AihubError } from "./errors.js";
import { currentTeamFile, proposeTeamChange } from "./teamPropose.js";
import { loadTeam } from "./team.js";

/** The fallback file for team rules when team.yaml lists no guidelines. */
export const TEAM_KNOWLEDGE = ".agents/skills/_shared/references/team-knowledge.md";

/** The guideline file the rule goes to: the first one team.yaml lists under `guidelines:`, else the team-knowledge file. */
export function knowledgeFile(team: ReturnType<typeof loadTeam>): string {
  const g = Array.isArray(team.guidelines) ? (team.guidelines as unknown[]).map(String).filter(Boolean) : [];
  return g[0] ?? TEAM_KNOWLEDGE;
}

const bullet = (rule: string) => `- ${rule.replace(/\s+/g, " ").trim()}`;

export function withRule(current: string | undefined, rule: string, nl: boolean): string {
  const base = current && current.trim() ? current.replace(/\r\n/g, "\n").replace(/\n*$/, "\n") : nl ? "# Teamkennis\n\nRegels die het team heeft geleerd; de agent leest ze voor hij code of tekst schrijft.\n\n" : "# Team knowledge\n\nRules the team has learned; the agent reads them before it writes code or text.\n\n";
  const line = bullet(rule);
  if (base.split("\n").some((l) => l.trim().toLowerCase() === line.toLowerCase())) return base;
  return base + line + "\n";
}

export async function teamLearn(ctx: Ctx, o: { rule?: string; json?: boolean }): Promise<string> {
  const rule = (o.rule ?? "").replace(/\s+/g, " ").trim();
  if (!rule) throw new AihubError('aihub team learn needs the rule: aihub team learn "<one sentence>"');
  if (rule.length > 300) throw new AihubError("a team rule is one sentence (at most 300 characters)");
  const { root } = repoClient(ctx);
  const team = loadTeam(root);
  const file = knowledgeFile(team);
  const nl = team.language === "nl";
  const slug = rule.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "rule";
  const r = await proposeTeamChange(ctx, {
    file,
    change: (cur) => withRule(cur ?? currentTeamFile(root, file), rule, nl),
    branch: `aihub/team-rule-${slug}`,
    title: nl ? `Teamregel: ${rule.slice(0, 60)}` : `Team rule: ${rule.slice(0, 60)}`,
    commitMessage: `docs: team rule "${rule.slice(0, 60)}"`,
    summary: nl ? `Voorstel van \`aihub team learn\` voor \`${file}\`: ${rule}` : `Proposal from \`aihub team learn\` for \`${file}\`: ${rule}`,
  });
  if (o.json) return JSON.stringify({ file, ...r });
  return r.changed ? `team rule proposed in ${file}: ${r.pr}\n(it counts once the pull request is merged)` : `that rule is already in ${file}`;
}
