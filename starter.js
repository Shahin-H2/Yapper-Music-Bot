// Your first Yapin’ bot. Needs Node 18+ (https://nodejs.org) and yapper.js next to this file.
//   1. Save yapper.js and package.json from https://www.yapin.gg/sdk/ into the same folder
//      (package.json just says these files are ES modules; Node 18-20 needs it).
//   2. Put your token in .env as YAPPER_BOT_TOKEN (Settings → Developer → Create). Never hardcode it here.
//   3. Add the bot to a server you manage (same place), then run:  node --env-file=.env starter.js
// The real bot is bot.js (npm start); this file is the SDK's original example.
import { Bot } from "./yapper.js";

const bot = new Bot(process.env.YAPPER_BOT_TOKEN);

// /ping → pong. Shows up in the "/" menu for everyone in the server.
bot.command("ping", "Is the bot alive?", (msg) => msg.reply("pong 🏓"));

// /roll 20 → a dice roll.
bot.command("roll", "Roll a die, like /roll 20", (msg) => {
  const n = Number(msg.argv[0]);
  const sides = Number.isSafeInteger(n) && n >= 2 && n <= 1000 ? n : 6; // no -5, 2.5 or Infinity
  msg.reply(`🎲 ${1 + Math.floor(Math.random() * sides)} (d${sides})`);
});

// Any message that @mentions the bot.
bot.on("message", (msg) => {
  if (msg.mentioned) msg.reply(`hey ${msg.authorMention}, try /ping`);
});

// Someone joined one of the bot's servers.
bot.on("member_join", async (ev) => {
  const channels = await bot.channels(ev.server_id);
  const general =
    channels.find(
      (c) => c.kind === "text" && /general|welcome|chat/i.test(c.name),
    ) || channels.find((c) => c.kind === "text");
  if (general)
    bot.send(
      general.id,
      `welcome <@${ev.user_id}>! you're member #${ev.member_count}`,
    );
});

// Give the bot a picture once (a PNG/JPG next to this file). Uncomment to use:
// bot.setAvatar('./avatar.png');

bot.start().catch((e) => {
  console.error("[yapper] could not start:", e.message);
  process.exit(1);
});
