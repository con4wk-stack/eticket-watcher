import fetch from "node-fetch";
import express from "express";

const url = "https://eplus.jp/sf/detail/0473460001";
const BASE_URL = "https://eplus.jp";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "Uaa7df44a6257eecb60409c763c087be5";

const NORMAL_INTERVAL = 30000; // 通常30秒
const BATTLE_INTERVAL = 15000; // 戦闘15秒
const RETRY_DELAY = 5000; // 失敗時5秒後リトライ
const TIMEOUT = 15000; // 15秒timeout

const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("Watcher running"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

console.log("Watcher started:", new Date().toISOString());

let lastState = false;
let retrying = false;

function isBattleTime() {
  const now = new Date();
  const japan = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const hour = japan.getHours();
  const minute = japan.getMinutes();

  if (hour === 11 && minute >= 55) return true;
  if (hour === 12 && minute <= 30) return true;
  return false;
}

/**
 * HTML からリリース（受付中）の公演ブロックを抽出し、
 * 公演日・公演時間・詳細ページリンクのリストを返す
 */
function parseReleasedItems(html) {
  const items = [];
  const dateRe = /20\d{2}\/\s*\d{1,2}\/\d{1,2}\([金土日水火木]\)/g;
  const timeRe = /開演[：:]\s*(\d{1,2}:\d{2})/;
  // button--primary の onclick 内 window.location.href='...' からURLを取得
  const detailLinkRe = /window\.location\.href='([^']+)'/g;

  const seen = new Set();
  let dateMatch;
  while ((dateMatch = dateRe.exec(html)) !== null) {
    const blockStart = dateMatch.index;
    const blockEnd = dateRe.lastIndex + 5000;
    const block = html.slice(blockStart, Math.min(blockEnd, html.length));
    if (!block.includes("button--primary")) continue;

    const 公演日 = dateMatch[0].replace(/\s+/g, " ").trim();
    const timeMatch = block.match(timeRe);
    const 公演時間 = timeMatch ? timeMatch[1] : "";
    const key = `${公演日}-${公演時間}`;
    if (seen.has(key)) continue;
    seen.add(key);

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

function buildNotificationMessage(releasedItems, pageUrl) {
  const lines = ["🎉 チケット戻ったよ！🥎", ""];
  for (const item of releasedItems) {
    const dateTime = `${item.公演日}　${item.公演時間 || "—"}～`;
    lines.push(dateTime);
    for (const link of item.詳細リンク) {
      lines.push(link);
    }
    if (item.詳細リンク.length === 0) {
      lines.push("(詳細リンクなし)");
    }
    lines.push("");
  }
  lines.push(`ページURL\n${pageUrl}`);
  return lines.join("\n").trim();
}

async function checkPage() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log("Fetch failed:", res.status);
      throw new Error("Fetch status error");
    }

    const html = await res.text();

    const isReleased = html.includes("button--primary");

    if (isReleased) {
      console.log("Checked at:", new Date().toISOString(), "(released)");

      // 未リリース→リリースに変わったときだけ通知（再販のたびに1回ずつ通知される）
      if (!lastState && LINE_TOKEN && LINE_USER_ID) {
        const releasedItems = parseReleasedItems(html);
        const message =
          releasedItems.length > 0
            ? buildNotificationMessage(releasedItems, url)
            : `🎉 チケット戻ったよ！🥎\n${url}`;

        await fetch("https://api.line.me/v2/bot/message/push", {
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

        console.log("LINE通知送信完了");
      }
    } else {
      console.log("Checked at:", new Date().toISOString(), "(not released)");
    }

    lastState = isReleased;
    retrying = false; // 成功したらリトライ解除
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
    await checkPage().catch(() => {}); // エラーでも次を必ずスケジュールする
    scheduleNextCheck();
  }, interval);
}

scheduleNextCheck();
