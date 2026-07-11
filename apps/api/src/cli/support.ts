/**
 * Small pieces of Node CLI bootstrapping shared by cli/backfill.ts and cli/screener.ts. Neither
 * helper corresponds to a specific function in the Python originals (backfill.py / cli.py) --
 * they're TS/Node-only glue (node:util's `parseArgs` needs a manual numeric-flag validator; ESM
 * has no `if __name__ == "__main__"`), so, unlike the ported business logic elsewhere in this
 * port, sharing them across the two CLIs doesn't diverge from any Python source of truth.
 */

/** Parses an optional numeric CLI flag, throwing with the flag's name on non-numeric input. */
export function parseNumberFlag(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`invalid value for ${flag}: "${raw}"`);
  }
  return parsed;
}

/** Runs `main` and propagates its exit code, but only when this module was invoked directly
 * (`node cli/foo.js`), not when imported by another module (e.g. a test). */
export function runIfMain(moduleUrl: string, main: () => Promise<number>): void {
  const isMainModule = moduleUrl === `file://${process.argv[1]}`;
  if (isMainModule) {
    main().then((code) => {
      process.exitCode = code;
    });
  }
}
