import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const rl = createInterface({ input: stdin, output: stdout });

async function ask(prompt: string): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}

async function main() {
  console.log("=== MTProto Authorization ===\n");

  // 1. API ID — env or prompt
  let apiId = Number(process.env.TELEGRAM_API_ID);
  if (!apiId) {
    console.log("Get API ID and Hash at https://my.telegram.org/apps\n");
    const apiIdStr = await ask("API ID: ");
    apiId = parseInt(apiIdStr, 10);
    if (isNaN(apiId)) {
      console.error("Invalid API ID");
      process.exit(1);
    }
  } else {
    console.log(`API ID: ${apiId} (from TELEGRAM_API_ID)`);
  }

  // 2. API Hash — env or prompt
  let apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!apiHash) {
    apiHash = await ask("API Hash: ");
    if (!apiHash) {
      console.error("API Hash is required");
      process.exit(1);
    }
  } else {
    console.log(`API Hash: ${apiHash.slice(0, 4)}... (from TELEGRAM_API_HASH)`);
  }

  // 3. Session path
  const defaultPath = `${homedir()}/.openclaw/plugins/telegram-admin-channel/mtproto.session`;
  const sessionPathInput = await ask(
    `\nSession file path [${defaultPath}]: `,
  );
  const sessionPath = sessionPathInput || defaultPath;

  // 4. Authorize
  const session = new StringSession("");
  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 3,
  });

  console.log("");
  await client.start({
    phoneNumber: async () => ask("Phone number (with country code): "),
    phoneCode: async () => ask("Verification code: "),
    password: async () => ask("2FA password (if enabled): "),
    onError: (err) => console.error("Error:", err.message),
  });

  console.log("\nAuthorized successfully!");

  const sessionStr = client.session.save() as unknown as string;

  await mkdir(dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, sessionStr, "utf-8");
  console.log(`Session saved to: ${sessionPath}\n`);

  console.log("Add this to your plugin config:\n");
  console.log(JSON.stringify({
    mtproto: {
      enabled: true,
      apiId,
      apiHash,
    },
  }, null, 2));
  console.log("\nOr use env vars TELEGRAM_API_ID / TELEGRAM_API_HASH and just:");
  console.log(JSON.stringify({ mtproto: { enabled: true } }, null, 2));
  console.log("");

  await client.disconnect();
  rl.close();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
