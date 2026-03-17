/**
 * ECR repo management — internal Pulumi program for component statics.
 *
 * Reads .as.service.yml from each component, generates a Pulumi index.ts
 * that declares ECR repos, and runs it as a managed stack. The stack is
 * stored alongside env/component state in the same S3 backend.
 *
 * Stack name: {stage}-statics
 * Project name: {system}-statics
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { exec } from "./shell.js";
import {
  resolveSystem,
  resolveStateBucket,
  resolveProfile,
  resolveRegion,
} from "./conventions.js";
import { discoverServiceConfigs } from "./service-config.js";

export function reconcileEcrRepos(root: string, stage: string): void {
  const system = resolveSystem(root);
  const profile = resolveProfile(root, stage);
  const region = resolveRegion(root, stage);
  const bucket = resolveStateBucket(root, stage);
  const configs = discoverServiceConfigs(root);

  const ecrRepos = configs
    .filter((c) => c.ecr_repo)
    .map((c) => ({ name: c.name, repo: `${system}/${c.ecr_repo}` }));

  if (ecrRepos.length === 0) {
    console.log("  No ECR repos declared in .as.service.yml files");
    return;
  }

  const workDir = `${tmpdir()}/ascli-statics-${system}`;
  mkdirSync(workDir, { recursive: true });

  generateStaticsProgram(workDir, system, ecrRepos);
  installDeps(workDir);
  loginAndSelectStack(workDir, system, stage, bucket, region, profile);
  runPulumiUp(workDir, stage, region, profile);
}

function generateStaticsProgram(
  workDir: string,
  system: string,
  repos: { name: string; repo: string }[],
): void {
  const repoDeclarations = repos
    .map(
      (r) =>
        `new aws.ecr.Repository("${r.name}-ecr", {
  name: "${r.repo}",
  imageScanningConfiguration: { scanOnPush: true },
  imageTagMutability: "MUTABLE",
  tags: { "managed-by": "ascli", system: "${system}" },
});`,
    )
    .join("\n\n");

  writeFileSync(
    `${workDir}/index.ts`,
    `import * as aws from "@pulumi/aws";

${repoDeclarations}
`,
  );

  writeFileSync(
    `${workDir}/Pulumi.yaml`,
    `name: ${system}-statics\nruntime:\n  name: nodejs\n  options:\n    typescript: true\n`,
  );

  // Always regenerate package.json to pick up latest @as/pulumi
  writeFileSync(
    `${workDir}/package.json`,
    JSON.stringify(
      {
        name: "ascli-statics",
        dependencies: {
          "@pulumi/pulumi": "^3.0.0",
          "@pulumi/aws": "^6.0.0",
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    `${workDir}/tsconfig.json`,
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2020",
          module: "commonjs",
          moduleResolution: "node",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
      null,
      2,
    ),
  );
}

function installDeps(workDir: string): void {
  if (!existsSync(`${workDir}/node_modules/@pulumi/aws`)) {
    exec("npm install --no-package-lock", { cwd: workDir });
  }
}

function loginAndSelectStack(
  workDir: string,
  system: string,
  stage: string,
  bucket: string,
  region: string,
  profile: string,
): void {
  exec(
    `pulumi login "s3://${bucket}?region=${region}&awssdk=v2${process.env.AWS_ACCESS_KEY_ID ? "" : `&profile=${profile}`}"`,
    { silent: true },
  );

  const stackName = `${stage}-statics`;
  try {
    exec(`pulumi stack select ${stackName}`, { cwd: workDir, silent: true });
  } catch {
    exec(`pulumi stack init ${stackName}`, { cwd: workDir });
  }
}

function runPulumiUp(
  workDir: string,
  stage: string,
  region: string,
  profile: string,
): void {
  exec(
    `pulumi up --yes --config aws:region=${region}${process.env.AWS_ACCESS_KEY_ID ? "" : ` --config aws:profile=${profile}`} --config stage=${stage}`,
    { cwd: workDir },
  );
}
