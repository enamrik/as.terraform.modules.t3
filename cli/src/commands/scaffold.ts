/**
 * ascli component:new <name>
 *
 * Scaffolds a new component with infrastructure and src directories.
 *
 * For Terraform engine:
 *   apps/<name>/infra/main.tf
 *   apps/<name>/infra/variables.tf
 *   apps/<name>/src/handler.ts
 *
 * For Pulumi engine:
 *   apps/<name>/infra/index.ts
 *   apps/<name>/src/handler.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { discoverRoot, resolveEngineName } from "../lib/conventions.js";

const MODULE_SOURCE =
  "git::https://github.com/kravariere-absencesoft/as.terraform.modules.t3.git//as-service?ref=main";

export type ComponentNewOptions = {
  name: string;
};

export function componentNewCommand(opts: ComponentNewOptions): void {
  const root = discoverRoot(process.cwd());
  const appDir = `${root}/apps/${opts.name}`;

  if (existsSync(appDir)) {
    console.error(`Directory already exists: apps/${opts.name}`);
    process.exit(1);
  }

  const engine = resolveEngineName(root);
  const srcDir = `${appDir}/src`;
  mkdirSync(srcDir, { recursive: true });

  if (engine === "pulumi") {
    scaffoldPulumi(appDir, opts.name);
  } else {
    scaffoldTerraform(appDir, opts.name);
  }

  writeFileSync(
    `${srcDir}/handler.ts`,
    `import { Hono } from "hono";
import { handle } from "hono/aws-lambda";

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

export const handler = handle(app);
`,
  );

  console.log(`Created apps/${opts.name}/`);
  console.log(`\nRun 'ascli init --stage dev --env integration' to initialize infrastructure.`);
}

function scaffoldPulumi(appDir: string, name: string): void {
  const infraDir = `${appDir}/infra`;
  mkdirSync(infraDir, { recursive: true });

  writeFileSync(
    `${infraDir}/index.ts`,
    `import * as pulumi from "@pulumi/pulumi";
import { AsService, AsEnvironment } from "@as/pulumi";

const config = new pulumi.Config();
const stage = config.require("stage");
const envName = config.require("envName");

const env = AsEnvironment.ref(stage, envName);

new AsService("${name}", {
  stage,
  envName,
  serviceName: "${name}",
  memory: 512,
  sha: config.get("sha"),
  connections: [
    env.gateway(),
  ],
  environmentVariables: {
    NODE_OPTIONS: "--enable-source-maps",
    SERVICE_NAME: "${name}",
  },
});
`,
  );

  console.log(`  infra/index.ts`);
}

function scaffoldTerraform(appDir: string, name: string): void {
  const tfDir = `${appDir}/infra`;
  mkdirSync(tfDir, { recursive: true });

  writeFileSync(
    `${tfDir}/main.tf`,
    `module "service" {
  source = "${MODULE_SOURCE}"

  stage    = var.stage
  env_name = var.env_name
  name     = "${name}"
  runtime  = "lambda"
  memory   = 512

  artifact_key = var.artifact_key

  environment_variables = {
    NODE_OPTIONS = "--enable-source-maps"
    SERVICE_NAME = "${name}"
  }
}
`,
  );

  writeFileSync(
    `${tfDir}/variables.tf`,
    `variable "stage" {
  description = "Deployment stage (e.g. dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "env_name" {
  description = "Environment name within the stage (e.g. integration, pr-123)"
  type        = string
  default     = "integration"
}

variable "artifact_key" {
  description = "S3 key for the Lambda zip artifact"
  type        = string
  default     = null
}
`,
  );

  console.log(`  infra/main.tf`);
  console.log(`  infra/variables.tf`);
}
