/**
 * ascli component:new <name>
 *
 * Scaffolds a new component with terraform and src directories.
 * Creates:
 *   apps/<name>/terraform/main.tf
 *   apps/<name>/terraform/variables.tf
 *   apps/<name>/src/handler.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { discoverRoot } from "../lib/conventions.js";

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

  const tfDir = `${appDir}/terraform`;
  const srcDir = `${appDir}/src`;

  mkdirSync(tfDir, { recursive: true });
  mkdirSync(srcDir, { recursive: true });

  writeFileSync(
    `${tfDir}/main.tf`,
    `module "service" {
  source = "${MODULE_SOURCE}"

  stage    = var.stage
  env_name = var.env_name
  name     = "${opts.name}"
  runtime  = "lambda"
  memory   = 512

  artifact_key = var.artifact_key

  environment_variables = {
    NODE_OPTIONS = "--enable-source-maps"
    SERVICE_NAME = "${opts.name}"
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
  console.log(`  terraform/main.tf`);
  console.log(`  terraform/variables.tf`);
  console.log(`  src/handler.ts`);
  console.log(`\nRun 'ascli init --stage dev --env integration' to initialize terraform.`);
}
