#!/usr/bin/env node

/**
 * ascli — AbsenceSoft CLI
 *
 * Owns: build, publish, deploy, rollback, env lifecycle, component lifecycle.
 * Reads .as.yml for stage config (profiles, regions, bucket names).
 * Generates backend/provider files and runs terraform directly.
 *
 * Change detection is NOT the CLI's job — pipelines decide what to run.
 */

import { createRequire } from "node:module";
import { Command } from "commander";
import { buildCommand } from "./commands/build.js";
import { publishCommand } from "./commands/publish.js";
import { deployCommand, rollbackCommand } from "./commands/deploy.js";
import {
  envApplyCommand,
  envDestroyCommand,
  envListCommand,
  envStatusCommand,
  envHistoryCommand,
} from "./commands/env.js";
import { componentApplyCommand, componentDestroyCommand } from "./commands/component.js";

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

// ─── build ───────────────────────────────────────────────────────────────────

program
  .command("build <service>")
  .description("Build a service artifact locally")
  .option("--platform <arch>", "Docker platform architecture", "arm64")
  .action((service: string, opts: { platform: string }) => {
    const result = buildCommand({ service, platform: opts.platform });
    console.log(`\nBuild complete: ${result.type} artifact at ${result.localPath}`);
  });

// ─── publish ─────────────────────────────────────────────────────────────────

program
  .command("publish <service>")
  .description("Upload a built artifact to S3/ECR")
  .requiredOption("--stage <stage>", "Target stage (dev, staging, prod)")
  .action((service: string, opts: { stage: string }) => {
    const result = publishCommand({ service, stage: opts.stage });
    console.log(`\nPublished: ${result.artifactUri}`);
  });

// ─── deploy ──────────────────────────────────────────────────────────────────

program
  .command("deploy <service>")
  .description("Fast code-only deploy via CodeDeploy (no terraform)")
  .requiredOption("--stage <stage>", "Target stage (dev, staging, prod)")
  .requiredOption("--env <env>", "Target environment (integration, pr-42, etc.)")
  .option("--sha <sha>", "Deploy a specific previously-published version (defaults to HEAD)")
  .action(
    async (
      service: string,
      opts: { stage: string; env: string; sha?: string },
    ) => {
      await deployCommand({
        service,
        stage: opts.stage,
        envName: opts.env,
        sha: opts.sha,
      });
    },
  );

// ─── rollback ────────────────────────────────────────────────────────────────

program
  .command("rollback <service>")
  .description("Rollback a component to its previous version (from manifest)")
  .requiredOption("--stage <stage>", "Target stage (dev, staging, prod)")
  .requiredOption("--env <env>", "Target environment")
  .action(
    async (service: string, opts: { stage: string; env: string }) => {
      await rollbackCommand({
        service,
        stage: opts.stage,
        envName: opts.env,
      });
    },
  );

// ─── env ─────────────────────────────────────────────────────────────────────

program
  .command("env:apply")
  .description("Apply system layer terraform (idempotent)")
  .requiredOption("--stage <stage>", "Target stage")
  .requiredOption("--env <env>", "Environment name")
  .option("-y, --yes", "Auto-approve terraform apply", false)
  .action((opts: { stage: string; env: string; yes: boolean }) => {
    envApplyCommand({
      stage: opts.stage,
      envName: opts.env,
      autoApprove: opts.yes,
    });
  });

program
  .command("env:destroy")
  .description("Destroy system layer + clean up manifest")
  .requiredOption("--stage <stage>", "Target stage")
  .requiredOption("--env <env>", "Environment name")
  .option("-y, --yes", "Auto-approve terraform destroy", false)
  .action(
    async (opts: { stage: string; env: string; yes: boolean }) => {
      await envDestroyCommand({
        stage: opts.stage,
        envName: opts.env,
        autoApprove: opts.yes,
      });
    },
  );

program
  .command("env:list")
  .description("List all environments for this system in a stage")
  .requiredOption("--stage <stage>", "Target stage")
  .action(async (opts: { stage: string }) => {
    await envListCommand({ stage: opts.stage });
  });

program
  .command("env:status")
  .description("Show current deployment manifest for an environment")
  .requiredOption("--stage <stage>", "Target stage")
  .requiredOption("--env <env>", "Environment name")
  .action(async (opts: { stage: string; env: string }) => {
    await envStatusCommand({
      stage: opts.stage,
      envName: opts.env,
    });
  });

program
  .command("env:history")
  .description("Show deployment history for an environment")
  .requiredOption("--stage <stage>", "Target stage")
  .requiredOption("--env <env>", "Environment name")
  .option("--service <service>", "Filter by service name")
  .action(
    async (opts: { stage: string; env: string; service?: string }) => {
      await envHistoryCommand({
        stage: opts.stage,
        envName: opts.env,
        service: opts.service,
      });
    },
  );

// ─── component ───────────────────────────────────────────────────────────────

program
  .command("component:apply")
  .description("Apply component terraform — all components or one (idempotent)")
  .requiredOption("--stage <stage>", "Target stage")
  .requiredOption("--env <env>", "Environment name")
  .requiredOption("--sha <sha>", "Git SHA for component artifact")
  .option("--component <name>", "Apply only this component (defaults to all)")
  .option("-y, --yes", "Auto-approve terraform apply", false)
  .action(
    (opts: {
      stage: string;
      env: string;
      sha: string;
      component?: string;
      yes: boolean;
    }) => {
      componentApplyCommand({
        stage: opts.stage,
        envName: opts.env,
        sha: opts.sha,
        component: opts.component,
        autoApprove: opts.yes,
      });
    },
  );

program
  .command("component:destroy")
  .description("Destroy component terraform — all components or one")
  .requiredOption("--stage <stage>", "Target stage")
  .requiredOption("--env <env>", "Environment name")
  .option("--component <name>", "Destroy only this component (defaults to all)")
  .option("-y, --yes", "Auto-approve terraform destroy", false)
  .action(
    (opts: {
      stage: string;
      env: string;
      component?: string;
      yes: boolean;
    }) => {
      componentDestroyCommand({
        stage: opts.stage,
        envName: opts.env,
        component: opts.component,
        autoApprove: opts.yes,
      });
    },
  );

program.parseAsync().catch((err: Error) => {
  if (err.name === "CredentialsProviderError") {
    console.error(`\nAWS credentials expired. Run: aws sso login`);
    process.exit(1);
  }
  console.error(`\n${err.message}`);
  process.exit(1);
});
