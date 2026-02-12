import fetch from "node-fetch";
import express from "express";

const url = "https://eplus.jp/sf/detail/0473460001";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";

const NORMAL_INTERVAL = 30000;
const BATTLE_INTERVAL = 15000;
const RETRY_DELAY = 5000;
const TIMEOUT = 15000;

const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("Watcher running"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

console.log("Watcher started:", new Date().toISOString());

let retrying = false;
// 通知済み公演（key = 公演日-公演時間）。売り切れで一覧から消えた公演は削除し、再販で再通知する
let notifiedKeys = new Set();

function isBattleTime() {
  const now = new Date();
  const japan = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const hour = japan.getHours();
  const minute = japan.getMinutes();

  if (hour === 11 && minute >= 55) return true;
  if (hour === 12 && minute <= 30) return true;
  return false;
}

function parseReleasedItems(html) {
  const items = [];
  const dateRe = /20\d{2}\/\s*\d{1,2}\/\d{1,2}\([^\)]+\)/g;
  const timeRe = /開演[：:]\s*(\d{1,2}:\d{2})/;
  const detailLinkRe = /window\.location\.href='([^']+)'/g;

  // 公演日の出現位置をすべて取得（ブロック境界に使う）
  const dateMatches = [];
  let m;
  while ((m = dateRe.exec(html)) !== null) {
    dateMatches.push({ index: m.index, text: m[0] });
  }

  for (let i = 0; i < dateMatches.length; i++) {
    const blockStart = dateMatches[i].index;
    const blockEnd = i + 1 < dateMatches.length ? dateMatches[i + 1].index : html.length;
    const block = html.slice(blockStart, blockEnd);

    if (!block.includes("button--primary")) continue;

    const 公演日 = dateMatches[i].text.replace(/\s+/g, " ").trim();
    const timeMatch = block.match(timeRe);
    const 公演時間 = timeMatch ? timeMatch[1] : "";

    const links = [];
    let linkMatch;
    detailLinkRe.lastIndex = 0;
    while ((linkMatch = detailLinkRe.exec(block)) !== null) {
      const href = linkMatch[1];
      if (!links.includes(href)) links.push(href);
    }

    items.push({ 公演日, 公演時間, 詳細リンク: links });
  }

  return items;
}

function buildNotificationMessage(item, pageUrl) {
  const lines = [
    "🎉 チケット戻ったよ！🥎",
    "",
    `公演日：${item.公演日}`,
    `開演：${item.公演時間 || "—"}～`,
  ];

  for (const link of item.詳細リンク) {
    lines.push(link);
  }

  lines.push("");
  lines.push(`ページURL`);
  lines.push(pageUrl);

  return lines.join("\n");
}

async function checkPage() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log("Fetch failed:", res.status);
      throw new Error("Fetch status error");
    }

    const html = await res.text();
    const releasedItems = parseReleasedItems(html);

    const currentKeys = new Set();

    for (const item of releasedItems) {
      const key = `${item.公演日}-${item.公演時間}`;
      currentKeys.add(key);

      // 新しく出現した公演だけ通知（売り切れ→再販で再び出現した場合も通知）
      if (!notifiedKeys.has(key)) {
        if (LINE_TOKEN && LINE_USER_ID) {
          const message = buildNotificationMessage(item, url);

          const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${LINE_TOKEN}`,
            },
            body: JSON.stringify({
              to: LINE_USER_ID,
              messages: [{ type: "text", text: message }],
            }),
          });

          if (lineRes.ok) {
            console.log("LINE通知送信:", key);
          } else {
            const errBody = await lineRes.text();
            console.error("LINE API エラー:", lineRes.status, errBody);
          }
        }

        notifiedKeys.add(key);
      }
    }

    // 消えた公演は通知済みから削除（再出現でまた通知できる）
    for (const key of notifiedKeys) {
      if (!currentKeys.has(key)) {
        notifiedKeys.delete(key);
      }
    }

    console.log("Checked at:", new Date().toISOString());
    retrying = false;
  } catch (err) {
    console.log("Fetch timeout or error");

    if (!retrying) {
      retrying = true;
      console.log("Retrying in 5 seconds...");
      setTimeout(checkPage, RETRY_DELAY);
    }
  }
}

function scheduleNextCheck() {
  const interval = isBattleTime() ? BATTLE_INTERVAL : NORMAL_INTERVAL;

  setTimeout(async () => {
    await checkPage().catch(() => {});
    scheduleNextCheck();
  }, interval);
}

scheduleNextCheck();
