/**
 * Foundation defaults — the canonical as-foundation account topology.
 *
 * ascli uses these when .as.yml doesn't override a stage's config.
 * To test against a single account, override profiles in .as.yml.
 */

export type FoundationStage = {
  profile: string;
  region: string;
};

export type FoundationConfig = {
  stages: Record<string, FoundationStage>;
  stateBucket: string;
  artifactBucket: string;
  deploymentsTable: string;
};

export const FOUNDATION: FoundationConfig = {
  stages: {
    dev: { profile: "as-dev", region: "us-east-1" },
    staging: { profile: "as-staging", region: "us-east-1" },
    prod: { profile: "as-prod", region: "us-east-1" },
  },
  stateBucket: "${profile}-terraform-state",
  artifactBucket: "as-artifacts",
  deploymentsTable: "as-deployments-${stage}",
};
