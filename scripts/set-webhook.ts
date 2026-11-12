/**
 * One-time setup: points your Telegram bot at the deployed webhook and registers the command menu.
 *   npx tsx scripts/set-webhook.ts https://your-app.vercel.app
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from the environment or .env.local. Never prints them.
 */
import { setMyCommands, setWebhook, TelegramError } from "../lib/alerts/telegram";

const COMMANDS = [
  { command: "calls", description: "Open calls and progress" },
  { command: "history", description: "Past calls, page by page" },
  { command: "stats", description: "Scoreboard and rank" },
  { command: "help", description: "What this bot does" },
];

async function main(): Promise<void> {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* no .env.local: rely on the real environment */
  }
  const appUrl = (process.argv[2] ?? "").replace(/\/+$/, "");
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!/^https:\/\/[^\s/]+/.test(appUrl)) throw new Error("Usage: npx tsx scripts/set-webhook.ts https://your-app.vercel.app");
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  if (!secretToken || !/^[A-Za-z0-9_-]{16,256}$/.test(secretToken)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must be 16-256 characters of A-Z, a-z, 0-9, _ or -.");
  }

  const url = `${appUrl}/api/telegram/webhook`;
  await setWebhook({ token, url, secretToken, fetchImpl: fetch });
  console.log(`Webhook set to ${url}`);
  await setMyCommands({ token, commands: COMMANDS, fetchImpl: fetch });
  console.log(`Registered ${COMMANDS.length} commands: ${COMMANDS.map((c) => `/${c.command}`).join(", ")}`);
}

main().catch((error: unknown) => {
  const message = error instanceof TelegramError ? `${error.message}${error.description ? `: ${error.description}` : ""}` : error instanceof Error ? error.message : "Unknown error";
  console.error(`Failed: ${message}`);
  process.exit(1);
});
