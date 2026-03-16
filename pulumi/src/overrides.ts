/**
 * Environment-aware overrides using glob pattern matching.
 *
 * Override keys can be:
 *   "pr-*"          — matches envName only (any stage)
 *   "prod/pr-*"     — matches stage exactly, envName by glob
 *   "integration"   — exact envName match (any stage)
 *   "prod/*"        — prod stage, any envName
 *
 * Specificity (most specific wins):
 *   1. stage/envName compound match (tier 2)
 *   2. envName-only match (tier 1)
 *   Within a tier: exact match beats glob, then first match wins.
 *
 * Override values are shallow-merged onto base props.
 */

export type Overrides<T> = Record<string, Partial<T>>;

/**
 * Converts a glob pattern to a RegExp.
 * Supports `*` (match any chars except `/`) and `?` (match one char).
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function isExactPattern(pattern: string): boolean {
  return !pattern.includes("*") && !pattern.includes("?");
}

interface ScoredMatch<T> {
  override: Partial<T>;
  tier: number;
  exact: boolean;
  index: number;
}

export function resolveOverrides<T>(
  stage: string,
  envName: string,
  overrides: Overrides<T>,
): Partial<T> {
  const matches: ScoredMatch<T>[] = [];

  const entries = Object.entries(overrides);
  for (const [i, [key, value]] of entries.entries()) {
    const slashIdx = key.indexOf("/");

    if (slashIdx >= 0) {
      // Compound key: stage/envPattern
      const stagePattern = key.substring(0, slashIdx);
      const envPattern = key.substring(slashIdx + 1);

      if (globToRegex(stagePattern).test(stage) && globToRegex(envPattern).test(envName)) {
        matches.push({
          override: value,
          tier: 2,
          exact: isExactPattern(stagePattern) && isExactPattern(envPattern),
          index: i,
        });
      }
    } else {
      // EnvName-only key
      if (globToRegex(key).test(envName)) {
        matches.push({
          override: value,
          tier: 1,
          exact: isExactPattern(key),
          index: i,
        });
      }
    }
  }

  if (matches.length === 0) return {};

  // Sort: highest tier first, exact beats glob, then declaration order
  matches.sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier;
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    return a.index - b.index;
  });

  return matches[0].override;
}
