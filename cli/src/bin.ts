#!/usr/bin/env node

/**
 * ascli — AbsenceSoft CLI
 *
 * Owns: build, publish, deploy, rollback, env lifecycle, component lifecycle,
 * artifact promotion, and convenience workflows (ship, up, down).
 *
 * Reads .as.yml for stage config (profiles, regions, bucket names).
 * Delegates infrastructure operations to the configured IaC engine.
 *
 * Change detection is NOT the CLI's job — pipelines decide what to run.
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import { buildCommand } from "./commands/build.js";
import { publishCommand } from "./commands/publish.js";
import { artifactCommand } from "./commands/artifact.js";
import { deployCommand, rollbackCommand } from "./commands/deploy.js";
import { shipCommand } from "./commands/ship.js";
import { upCommand } from "./commands/up.js";
import { downCommand } from "./commands/down.js";
import { promoteCommand } from "./commands/promote.js";
import { artifactTagCommand } from "./commands/artifact-tag.js";
import { artifactStatusCommand } from "./commands/artifact-status.js";
import {
  envApplyCommand,
  envDestroyCommand,
  envListCommand,
  envStatusCommand,
  envHistoryCommand,
  envSyncCommand,
} from "./commands/env.js";
import { componentApplyCommand, componentDestroyCommand } from "./commands/component.js";
import { initCommand } from "./commands/init.js";
import { componentNewCommand } from "./commands/scaffold.js";
import { resolveEngine } from "./lib/resolve-engine.js";
import { resolveEnvName, DEFAULT_STAGE } from "./lib/conventions.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const program = new Command();

program
  .name("ascli")
  .description(`AbsenceSoft CLI v${version}`)
  .version(version)
  .action(() => {
    program.outputHelp();
  });

// ─── ship (build + publish + deploy) ─────────────────────────────────────────

program
  .command("ship <service>")
  .description("Build, publish, and deploy a service (artifact → component:apply → deploy)")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Target environment")
  .option("--dirty", "Allow dirty-tree builds", false)
  .option("--platform <arch>", "Docker platform architecture", "arm64")
  .action(async (service: string, opts: { stage: string; env?: string; dirty: boolean; platform: string }) => {
    await shipCommand({
      service,
      stage: opts.stage,
      envName: opts.env,
      dirty: opts.dirty,
      platform: opts.platform,
    });
  });

// ─── up (stand up environment) ───────────────────────────────────────────────

program
  .command("up")
  .description("Stand up an environment (env:apply → artifact all → component:apply all)")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Target environment")
  .option("-y, --yes", "Auto-approve", false)
  .option("--from <tag>", "Clone from tagged artifacts (e.g., staging)")
  .option("--dirty", "Allow dirty-tree builds", false)
  .option("--platform <arch>", "Docker platform architecture", "arm64")
  .action(async (opts: { stage: string; env?: string; yes: boolean; from?: string; dirty: boolean; platform: string }) => {
    await upCommand({
      stage: opts.stage,
      envName: opts.env,
      yes: opts.yes,
      from: opts.from,
      dirty: opts.dirty,
      platform: opts.platform,
    });
  });

// ─── down (tear down environment) ────────────────────────────────────────────

program
  .command("down")
  .description("Tear down an environment (component:destroy → env:destroy)")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Target environment")
  .option("-y, --yes", "Auto-approve", false)
  .action(async (opts: { stage: string; env?: string; yes: boolean }) => {
    await downCommand({ stage: opts.stage, envName: opts.env, yes: opts.yes });
  });

// ─── promote ─────────────────────────────────────────────────────────────────

program
  .command("promote")
  .description("Promote staging-tagged artifacts to a target stage")
  .requiredOption("--to <stage>", "Target stage to promote to")
  .option("--service <service>", "Single service (default: all)")
  .option("--force", "Skip deploy guards", false)
  .action(async (opts: { to: string; service?: string; force: boolean }) => {
    await promoteCommand({ to: opts.to, service: opts.service, force: opts.force });
  });

// ─── init ────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Initialize project (.as.yml) and optionally IaC roots")
  .option("--system <name>", "System name (default: root folder name)")
  .option("--stage <stage>", "Also run IaC init for this stage")
  .option("--env <env>", "Environment name (for IaC init)")
  .action((opts: { system?: string; stage?: string; env?: string }) => {
    const engine = opts.stage ? resolveEngine() : undefined;
    initCommand({ system: opts.system, stage: opts.stage, envName: opts.env }, engine);
  });

// ─── build ───────────────────────────────────────────────────────────────────

program
  .command("build <service>")
  .description("Build a service artifact locally")
  .option("--platform <arch>", "Docker platform architecture", "arm64")
  .option("--dirty", "Allow dirty-tree builds", false)
  .action((service: string, opts: { platform: string; dirty: boolean }) => {
    const result = buildCommand({ service, platform: opts.platform, dirty: opts.dirty });
    console.log(`\nBuild complete: ${result.type} artifact at ${result.localPath}`);
  });

// ─── publish ─────────────────────────────────────────────────────────────────

program
  .command("publish <service>")
  .description("Upload a built artifact to S3/ECR")
  .requiredOption("--stage <stage>", "Target stage (dev, staging, prod)")
  .option("--dirty", "Allow dirty-tree builds", false)
  .action(async (service: string, opts: { stage: string; dirty: boolean }) => {
    const result = await publishCommand({ service, stage: opts.stage, dirty: opts.dirty });
    console.log(`\nPublished: ${result.artifactUri}`);
  });

// ─── artifact (build + publish) ──────────────────────────────────────────────

program
  .command("artifact <service>")
  .description("Build and publish a service artifact (build + publish)")
  .requiredOption("--stage <stage>", "Target stage (dev, staging, prod)")
  .option("--platform <arch>", "Docker platform architecture", "arm64")
  .option("--dirty", "Allow dirty-tree builds", false)
  .action(async (service: string, opts: { stage: string; platform: string; dirty: boolean }) => {
    const result = await artifactCommand({ service, stage: opts.stage, platform: opts.platform, dirty: opts.dirty });
    console.log(`\nArtifact ready: ${result.artifactUri}`);
  });

// ─── artifact:tag ────────────────────────────────────────────────────────────

program
  .command("artifact:tag <service>")
  .description("Tag an artifact with a lifecycle stage (dev, staging, staging_rejected, prod)")
  .requiredOption("--sha <sha>", "Artifact SHA to tag")
  .requiredOption("--tag <tag>", "Tag name")
  .requiredOption("--stage <stage>", "Stage for AWS config resolution")
  .option("--reason <reason>", "Rejection reason (required for staging_rejected)")
  .action(async (service: string, opts: { sha: string; tag: string; stage: string; reason?: string }) => {
    await artifactTagCommand({ service, sha: opts.sha, tag: opts.tag, stage: opts.stage, reason: opts.reason });
  });

// ─── artifact:status ─────────────────────────────────────────────────────────

program
  .command("artifact:status <service>")
  .description("Show artifact lifecycle status and tags")
  .requiredOption("--stage <stage>", "Stage for AWS config resolution")
  .option("--sha <sha>", "Specific SHA (default: show latest per tag)")
  .action(async (service: string, opts: { stage: string; sha?: string }) => {
    await artifactStatusCommand({ service, stage: opts.stage, sha: opts.sha });
  });

// ─── deploy ──────────────────────────────────────────────────────────────────

program
  .command("deploy <service>")
  .description("Fast code-only deploy via CodeDeploy (no infrastructure changes)")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Target environment")
  .option("--sha <sha>", "Deploy a specific previously-published version")
  .option("--image-uri <uri>", "ECR image URI (required for ECS CodeDeploy)")
  .option("--force", "Skip deploy guards", false)
  .action(
    async (
      service: string,
      opts: { stage: string; env?: string; sha?: string; imageUri?: string; force: boolean },
    ) => {
      await deployCommand({
        service,
        stage: opts.stage,
        envName: opts.env,
        sha: opts.sha,
        imageUri: opts.imageUri,
        force: opts.force,
      });
    },
  );

// ─── rollback ────────────────────────────────────────────────────────────────

program
  .command("rollback <service>")
  .description("Rollback a service to its previous version or a specific SHA")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Target environment")
  .option("--to <sha>", "Rollback to a specific SHA (default: previous version)")
  .action(
    async (service: string, opts: { stage: string; env?: string; to?: string }) => {
      await rollbackCommand({
        service,
        stage: opts.stage,
        envName: opts.env,
        toSha: opts.to,
      });
    },
  );

// ─── env ─────────────────────────────────────────────────────────────────────

program
  .command("env:apply")
  .description("Apply system layer infrastructure (idempotent)")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Environment name")
  .option("-y, --yes", "Auto-approve", false)
  .action((opts: { stage: string; env?: string; yes: boolean }) => {
    const engine = resolveEngine();
    envApplyCommand({ stage: opts.stage, envName: opts.env, autoApprove: opts.yes }, engine);
  });

program
  .command("env:destroy")
  .description("Destroy system layer + clean up manifest")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Environment name")
  .option("-y, --yes", "Auto-approve", false)
  .action(
    async (opts: { stage: string; env?: string; yes: boolean }) => {
      const engine = resolveEngine();
      await envDestroyCommand({ stage: opts.stage, envName: opts.env, autoApprove: opts.yes }, engine);
    },
  );

program
  .command("env:list")
  .description("List all environments for this system in a stage")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .action(async (opts: { stage: string }) => {
    await envListCommand({ stage: opts.stage });
  });

program
  .command("env:status")
  .description("Show current deployment manifest for an environment")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Environment name")
  .action(async (opts: { stage: string; env?: string }) => {
    await envStatusCommand({ stage: opts.stage, envName: opts.env });
  });

program
  .command("env:history")
  .description("Show deployment history for an environment")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Environment name")
  .option("--service <service>", "Filter by service name")
  .action(
    async (opts: { stage: string; env?: string; service?: string }) => {
      await envHistoryCommand({
        stage: opts.stage,
        envName: opts.env,
        service: opts.service,
      });
    },
  );

program
  .command("env:sync")
  .description("Sync environment to its tagged artifact baseline")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Environment name")
  .action(async (opts: { stage: string; env?: string }) => {
    await envSyncCommand({ stage: opts.stage, envName: opts.env });
  });

// ─── component ───────────────────────────────────────────────────────────────

program
  .command("component:apply")
  .description("Apply component infrastructure — all components or one (idempotent)")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Environment name")
  .requiredOption("--sha <sha>", "Git SHA for component artifact")
  .option("--component <name>", "Apply only this component (defaults to all)")
  .option("-y, --yes", "Auto-approve", false)
  .action(
    (opts: {
      stage: string;
      env?: string;
      sha: string;
      component?: string;
      yes: boolean;
    }) => {
      const envName = resolveEnvName(opts.stage, opts.env);
      const engine = resolveEngine();
      componentApplyCommand(
        {
          stage: opts.stage,
          envName,
          sha: opts.sha,
          component: opts.component,
          autoApprove: opts.yes,
        },
        engine,
      );
    },
  );

program
  .command("component:destroy")
  .description("Destroy component infrastructure — all components or one")
  .option("--stage <stage>", "Target stage", DEFAULT_STAGE)
  .option("--env <env>", "Environment name")
  .option("--component <name>", "Destroy only this component (defaults to all)")
  .option("-y, --yes", "Auto-approve", false)
  .action(
    (opts: {
      stage: string;
      env?: string;
      component?: string;
      yes: boolean;
    }) => {
      const envName = resolveEnvName(opts.stage, opts.env);
      const engine = resolveEngine();
      componentDestroyCommand(
        {
          stage: opts.stage,
          envName,
          component: opts.component,
          autoApprove: opts.yes,
        },
        engine,
      );
    },
  );

program
  .command("component:new <name>")
  .description("Scaffold a new component (infrastructure + src)")
  .action((name: string) => {
    componentNewCommand({ name });
  });

program.parseAsync().catch((err: Error) => {
  if (err.name === "CredentialsProviderError") {
    console.error(`\nAWS credentials expired. Run: aws sso login`);
    process.exit(1);
  }
  console.error(`\n${err.message}`);
  process.exit(1);
});
