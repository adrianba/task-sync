#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Flags:
 *   --once        run a single reconciliation pass and exit
 *   --dry-run     observe-only: never write to the vault or any backend
 *   --config <p>  path to a JSON config file
 *   --version     print the version and exit
 *   --help        print usage
 *
 * Configuration is layered: defaults → config file → environment → these flags.
 */
import { loadConfig } from "./config.js";
import { Service } from "./service.js";
import { logger } from "./logger.js";
import { VERSION } from "./version.js";

interface CliArgs {
  once: boolean;
  dryRun: boolean;
  configPath?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    once: false,
    dryRun: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--once":
        args.once = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--config": {
        const value = argv[++i];
        if (value === undefined) throw new Error("--config requires a path");
        args.configPath = value;
        break;
      }
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

const USAGE = `task-sync v${VERSION} — sync Obsidian Tasks with external task managers

Usage: task-sync [options]

Options:
  --once          Run a single reconciliation pass and exit
  --dry-run       Observe-only; never write to the vault or backends
  --config <path> Path to a JSON config file
  -v, --version   Print the version and exit
  -h, --help      Show this help

Environment: see README.md for the full list (TASK_SYNC_*, MS_*, SUPERNOTE_*).`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(VERSION + "\n");
    return;
  }
  if (args.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const config = loadConfig({
    ...(args.configPath ? { configPath: args.configPath } : {}),
    ...(args.dryRun ? { overrides: { dryRun: true } } : {}),
  });

  const service = new Service(config, { once: args.once, dryRun: config.dryRun });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Received shutdown signal", { signal });
    service
      .stop()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error("Error during shutdown", { err });
        process.exit(1);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await service.start();

  // In once mode start() resolves after the single pass. Exit non-zero if that
  // pass failed or any backend errored (e.g. first-run auth not completed) so
  // scripted/cron callers can detect failure. Continuous mode keeps running.
  if (args.once) {
    process.exit(service.runFailed ? 1 : 0);
  }
}

main().catch((err: unknown) => {
  logger.error("Fatal error", { err });
  process.exit(1);
});
