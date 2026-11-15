/**
 * Command-line arguments for the hit-review CLI.
 *
 * Kept separate from `hit-review-cli.ts` so the parser can be imported and
 * tested without executing the CLI entry point. Chronological review is the
 * default; the earlier cost-ranked selection requires --legacy-ranked.
 */

import os from "node:os";
import path from "node:path";

import { DEFAULT_MAX_OUT_SIZE, parseByteSize } from "./outputRetention.js";

export interface CliArgs {
  paths: string[];
  dirs: string[];
  replays: string[];
  target: string | null;
  limit: number;
  minDamage: number | null;
  deathsOnly: boolean;
  chronological: boolean;
  cursorPath: string;
  resetCursor: boolean;
  json: boolean;
  render: boolean;
  outDir: string | null;
  telegram: boolean;
  telegramCheck: boolean;
  telegramChat: string | null;
  statePath: string;
  noState: boolean;
  force: boolean;
  all: boolean;
  sinceHours: number;
  resolution: string;
  maxOutBytes: number;
  backend: string | null;
  noXvfb: boolean;
  dryRun: boolean;
  verbose: boolean;
  help: boolean;
}

const DEFAULT_LIMIT = 2;
const DEFAULT_SINCE_HOURS = 48;

export const USAGE = `Usage: npx tsx src/hit-review-cli.ts [paths...] [options]

Finds the moments the target player got hit, groups nearby hits, and can render
each sequence to MP4 and send it to Telegram.

Replay input:
  --dir PATH            Scan a folder recursively for .slp files (repeatable)
  --replay PATH         Add a replay (repeatable)
  positional paths      Files or folders; folders are scanned

Selection (chronological review, the default):
  --target TAG|CODE     Player to review (default: MAGI config or MAGI_TARGET)
  --limit N             Clips to render/send (default: ${DEFAULT_LIMIT}; 0 = all)
  --min-damage N        Ignore events whose full conversion is below this damage
  --deaths-only         Only events whose conversion took a stock
  --legacy-ranked       Use the earlier cost-ranked mode instead of chronological
                        review. Its --state/--since-hours/--all/--no-state
                        options are rejected without this flag.
  --chronological       Chronological review (the default; accepted for
                        compatibility with older scripts)

Output:
  --json                Print the selected sequences as JSON (progress goes to stderr)
  --render              Render each selected sequence with scripts/render-clip.sh
  --out-dir PATH        Clip directory (default: ~/.magi-melee/hit-review)
  --max-out-size SIZE   Delete oldest produced clips above this cap, e.g. 500MB/1GB
                        (default: ${DEFAULT_MAX_OUT_SIZE}; 0 disables pruning)
  --resolution RES      480p/720p/1080p/2160p or raw EFBScale (default: 720p)
  --backend NAME        Dolphin video backend (default: script default)
  --no-xvfb             Do not start a private virtual display
  --dry-run             Show what would be rendered/sent, but do nothing

Telegram:
  --telegram            Send rendered clips (implies --render)
  --telegram-chat ID    Override TELEGRAM_CHAT_ID
  --telegram-check      Print the bot identity and recently seen chat ids, then exit

State:
  --cursor PATH         Chronological cursor file (default: ./data/hit-review-cursor.json)
  --reset-cursor        Ignore the saved cursor for this run; it advances after the first success
  --force               Reprocess/resend; in chronological mode, ignore the cursor for selection
  --verbose             Print per-replay detail

Legacy cost-ranked mode (requires --legacy-ranked):
  --state PATH          State file (default: ~/.magi-melee/hit-review-state.json)
  --since-hours N       On a fresh state, only scan files newer than N hours
                        (default: ${DEFAULT_SINCE_HOURS}; 0 = all)
  --all                 Process every discovered replay, regardless of state/age
  --no-state            Do not read or write state

Environment:
  MAGI_TARGET, CLIPPI_TARGET           Target tag/connect code
  TELEGRAM_BOT_TOKEN                    Bot token from @BotFather
  TELEGRAM_CHAT_ID                      Destination chat id or @channelusername
  SLIPPI_PLAYBACK, MELEE_ISO           Paths used by scripts/render-clip.sh
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    paths: [],
    dirs: [],
    replays: [],
    target: null,
    limit: DEFAULT_LIMIT,
    minDamage: null,
    deathsOnly: false,
    chronological: true,
    cursorPath: path.resolve(process.cwd(), "data", "hit-review-cursor.json"),
    resetCursor: false,
    json: false,
    render: false,
    outDir: null,
    telegram: false,
    telegramCheck: false,
    telegramChat: null,
    statePath: path.join(os.homedir(), ".magi-melee", "hit-review-state.json"),
    noState: false,
    force: false,
    all: false,
    sinceHours: DEFAULT_SINCE_HOURS,
    resolution: process.env.CLIPPI_RESOLUTION?.trim() || "720p",
    maxOutBytes: parseByteSize(DEFAULT_MAX_OUT_SIZE),
    backend: null,
    noXvfb: false,
    dryRun: false,
    verbose: false,
    help: false,
  };

  // Chronological review is the default. --legacy-ranked opts into the older
  // cost-ranked mode, and its legacy-only options are rejected without it so a
  // mistyped run cannot silently switch selection strategies.
  let mode: "chronological" | "legacy" | null = null;
  let legacyOption: string | null = null;

  let i = 0;
  while (i < argv.length) {
    const raw = argv[i]!;
    if (raw === "-h" || raw === "--help") {
      args.help = true;
      i++;
      continue;
    }
    if (!raw.startsWith("--")) {
      args.paths.push(raw);
      i++;
      continue;
    }

    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : raw.slice(equalsIndex + 1);
    const takeValue = (): string => {
      if (inlineValue !== null) {
        i++;
        return inlineValue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value`);
      i += 2;
      return next;
    };

    switch (name) {
      case "--dir":
        args.dirs.push(takeValue());
        break;
      case "--replay":
        args.replays.push(takeValue());
        break;
      case "--target":
        args.target = takeValue();
        break;
      case "--limit":
        args.limit = parseInteger(name, takeValue(), 0);
        break;
      case "--min-damage":
        args.minDamage = parseNumber(name, takeValue(), 0);
        break;
      case "--deaths-only":
        args.deathsOnly = true;
        i++;
        break;
      case "--chronological":
        if (mode === "legacy") throw new Error("--chronological and --legacy-ranked cannot be combined");
        mode = "chronological";
        i++;
        break;
      case "--legacy-ranked":
        if (mode === "chronological") throw new Error("--chronological and --legacy-ranked cannot be combined");
        mode = "legacy";
        i++;
        break;
      case "--cursor":
        args.cursorPath = path.resolve(expandHome(takeValue()));
        break;
      case "--reset-cursor":
        args.resetCursor = true;
        i++;
        break;
      case "--json":
        args.json = true;
        i++;
        break;
      case "--render":
        args.render = true;
        i++;
        break;
      case "--out-dir":
        args.outDir = takeValue();
        break;
      case "--telegram":
        args.telegram = true;
        i++;
        break;
      case "--telegram-chat":
        args.telegramChat = takeValue();
        break;
      case "--telegram-check":
        args.telegramCheck = true;
        i++;
        break;
      case "--state":
        legacyOption = name;
        args.statePath = path.resolve(expandHome(takeValue()));
        break;
      case "--since-hours":
        legacyOption = name;
        args.sinceHours = parseNumber(name, takeValue(), 0);
        break;
      case "--all":
        legacyOption = name;
        args.all = true;
        i++;
        break;
      case "--force":
        args.force = true;
        i++;
        break;
      case "--no-state":
        legacyOption = name;
        args.noState = true;
        i++;
        break;
      case "--resolution":
        args.resolution = takeValue();
        break;
      case "--max-out-size":
        args.maxOutBytes = parseByteSize(takeValue());
        break;
      case "--backend":
        args.backend = takeValue();
        break;
      case "--no-xvfb":
        args.noXvfb = true;
        i++;
        break;
      case "--dry-run":
        args.dryRun = true;
        i++;
        break;
      case "--verbose":
        args.verbose = true;
        i++;
        break;
      default:
        throw new Error(`Unknown option: ${name}\n\n${USAGE}`);
    }
  }

  if (legacyOption && mode !== "legacy") {
    throw new Error(`${legacyOption} only applies to the legacy cost-ranked mode; add --legacy-ranked`);
  }
  args.chronological = mode !== "legacy";

  if (args.telegram) args.render = true;
  return args;
}

export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseInteger(name: string, value: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer >= ${min}`);
  return parsed;
}

function parseNumber(name: string, value: string, min: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${name} must be a number >= ${min}`);
  return parsed;
}
