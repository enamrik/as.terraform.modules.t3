/**
 * PulumiEngine — implements IacEngine using Pulumi CLI.
 *
 * Stack naming: {stage}-{envName} for system, {stage}-{envName}-{service} for components.
 * State stored in the same S3 bucket as Terraform, under .pulumi/ prefix.
 *
 * Generates Pulumi.yaml, package.json, and tsconfig.json at init time
 * so the repo only needs to contain index.ts (the semantic infrastructure code).
 */

import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, execAsync } from "./shell.js";
import type { IacEngine, IacInitOpts, IacRunOpts } from "./engine.js";
import {
  resolveStateBucket,
  resolveProfile,
  resolveRegion,
  resolveIacRoot,
  resolveSystem,
} from "./conventions.js";

export class PulumiEngine implements IacEngine {
  readonly name = "pulumi";

  init(opts: IacInitOpts): void {
    const cwd = resolveIacRoot(opts.root, opts.type, opts.serviceName);
    this.login(opts);
    this.ensureProjectFiles(cwd, this.projectName(opts));
    this.selectOrCreateStack(cwd, opts);
    exec("npm install --no-package-lock", { cwd });
    // In CI, @as/pulumi is globally linked — wire it into this project
    exec("npm link @as/pulumi 2>/dev/null || true", { cwd, silent: true });
  }

  apply(opts: IacRunOpts): void {
    this.run("up", opts);
  }

  destroy(opts: IacRunOpts): void {
    this.run("destroy", opts);
  }

  plan(opts: IacRunOpts): void {
    this.run("preview", opts);
  }

  applyAsync(opts: IacRunOpts & { prefix?: string }): Promise<void> {
    return this.runAsync("up", opts);
  }

  destroyAsync(opts: IacRunOpts & { prefix?: string }): Promise<void> {
    return this.runAsync("destroy", opts);
  }

  private run(action: string, opts: IacRunOpts): void {
    this.init(opts);
    const cwd = resolveIacRoot(opts.root, opts.type, opts.serviceName);
    const configArgs = this.buildConfig(opts);
    const approve = opts.autoApprove ? "--yes" : "";
    exec(`pulumi ${action} ${configArgs} ${approve}`.trim(), {
      cwd,
      env: { PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? "" },
    });
  }

  private async runAsync(action: string, opts: IacRunOpts & { prefix?: string }): Promise<void> {
    this.init(opts);
    const cwd = resolveIacRoot(opts.root, opts.type, opts.serviceName);
    const configArgs = this.buildConfig(opts);
    const approve = opts.autoApprove ? "--yes" : "";
    await execAsync(`pulumi ${action} ${configArgs} ${approve}`.trim(), {
      cwd,
      prefix: opts.prefix,
      env: { PULUMI_CONFIG_PASSPHRASE: process.env.PULUMI_CONFIG_PASSPHRASE ?? "" },
    });
  }

  private login(opts: IacInitOpts): void {
    const bucket = resolveStateBucket(opts.root, opts.stage);
    const region = resolveRegion(opts.root, opts.stage);
    const profileParam = process.env.CI
      ? ""
      : `&profile=${resolveProfile(opts.root, opts.stage)}`;
    exec(
      `pulumi login "s3://${bucket}?region=${region}&awssdk=v2${profileParam}"`,
      { silent: true },
    );
  }

  private stackName(opts: IacInitOpts): string {
    if (opts.type === "env") {
      return `${opts.stage}-${opts.envName}`;
    }
    return `${opts.stage}-${opts.envName}-${opts.serviceName}`;
  }

  private selectOrCreateStack(cwd: string, opts: IacInitOpts): void {
    const name = this.stackName(opts);
    try {
      exec(`pulumi stack select ${name}`, { cwd, silent: true });
    } catch {
      exec(`pulumi stack init ${name}`, { cwd });
    }
  }

  private buildConfig(opts: IacRunOpts): string {
    const region = resolveRegion(opts.root, opts.stage);
    const vars: Record<string, string> = {
      "aws:region": region,
      stage: opts.stage,
      envName: opts.envName,
      ...opts.vars,
    };
    // Only set aws:profile when running locally (not in CI with env var credentials)
    if (!process.env.CI) {
      vars["aws:profile"] = resolveProfile(opts.root, opts.stage);
    }
    return Object.entries(vars)
      .map(([k, v]) => `--config ${k}=${v}`)
      .join(" ");
  }

  private projectName(opts: IacInitOpts): string {
    const system = resolveSystem(opts.root);
    if (opts.type === "env") return system;
    return `${system}-${opts.serviceName}`;
  }

  /**
   * Generates Pulumi.yaml, package.json, and tsconfig.json if they don't exist.
   * These are mechanical files (like _backend.tf/_provider.tf for Terraform) —
   * the repo only needs index.ts.
   */
  private ensureProjectFiles(cwd: string, name: string): void {
    const pulumiYamlPath = `${cwd}/Pulumi.yaml`;
    if (!existsSync(pulumiYamlPath)) {
      writeFileSync(
        pulumiYamlPath,
        `name: ${name}\nruntime:\n  name: nodejs\n  options:\n    typescript: true\n`,
      );
    }
    const pkgPath = `${cwd}/package.json`;
    if (!existsSync(pkgPath)) {
      const pulumiPkgPath = this.resolvePulumiPackagePath();
      writeFileSync(
        pkgPath,
        JSON.stringify(
          {
            name: "pulumi-project",
            dependencies: {
              "@pulumi/pulumi": "^3.0.0",
              "@pulumi/aws": "^6.0.0",
              "@as/pulumi": `file:${pulumiPkgPath}`,
            },
          },
          null,
          2,
        ),
      );
    }

    const tsconfigPath = `${cwd}/tsconfig.json`;
    if (!existsSync(tsconfigPath)) {
      writeFileSync(
        tsconfigPath,
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
  }

  /**
   * Resolves the absolute path to the @as/pulumi package.
   * Walks up from the CLI's installation directory to find the sibling pulumi/ dir.
   */
  private resolvePulumiPackagePath(): string {
    const __filename = fileURLToPath(import.meta.url);
    let dir = dirname(__filename);
    for (let i = 0; i < 10; i++) {
      const candidate = resolve(dir, "pulumi/package.json");
      if (existsSync(candidate)) return resolve(dir, "pulumi");
      dir = dirname(dir);
    }
    throw new Error(
      "Could not find @as/pulumi package relative to CLI installation. " +
        "Ensure the pulumi/ directory exists in the as.terraform.modules.t3 repository.",
    );
  }
}
