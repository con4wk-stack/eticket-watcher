/**
 * チケット監視（ローチケ）
 * ページ内 JSON の dispSeatInfo を見る。
 * 9（event-soldout）が 1（event-few）または 0（event-seatsLeft）に変わった公演だけ
 * LINE / Chatwork に通知する。
 */
import fetch from "node-fetch";
import express from "express";

const LTIKE_URL = "https://l-tike.com/order/?gLcode=35568";

const SOLDOUT = "9";
const AVAILABLE = new Set(["1", "0"]);

const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "C755fb6ffbd64b76818fd0a4dac5b130f";

const _cwRoomRaw = (process.env.CHATWORK_ROOM_ID || "rid425512899").trim();
const CHATWORK_TOKEN = (process.env.CHATWORK_TOKEN || "70e88dacd51fa5ed6d319dea68286761").trim();
const CHATWORK_ROOM_ID = _cwRoomRaw.match(/rid(\d+)/)?.[1] || _cwRoomRaw.replace(/\D/g, "") || "";

const NORMAL_INTERVAL = 30000;
const BATTLE_INTERVAL = 15000;
const RETRY_DELAY = 5000;
const TIMEOUT = 15000;
const FIVE_XX_RETRY_COUNT = 3;
const FIVE_XX_RETRY_WAIT_MS = 15000;

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10001;
app.get("/", (req, res) => res.send("Lawson ticket watcher running"));
app.post("/webhook", (req, res) => {
  console.log("Webhook受信:");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

console.log("Watcher started:", new Date().toISOString());
console.log("Target:", LTIKE_URL);
console.log("通知条件: dispSeatInfo 9 → 1 または 0");

let retrying = false;
// key = 公演日-開演時刻。値は直前の dispSeatInfo
let lastStatus = new Map();

function isBattleTime() {
  const now = new Date();
  const japan = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
  const hour = japan.getHours();
  const minute = japan.getMinutes();

  if (hour === 11 && minute >= 55) return true;
  if (hour === 12 && minute <= 30) return true;
  return false;
}

function parseShows(html) {
  const match = html.match(/<script type="application\/json" id="form-data">\s*([\s\S]*?)\s*<\/script>/);
  if (!match) throw new Error("form-data がありません");
  const data = JSON.parse(match[1]);
  const list = data.pfInfoListBean?.pfInfoDetailListBeanList || [];
  const shows = [];

  for (const performance of list) {
    for (const detail of performance.pfInfoDetailList || []) {
      const date = performance.pfDate || "";
      const time = detail.curtainTime || "";
      if (!date || !time) continue;
      shows.push({
        key: `${date}-${time}`,
        date,
        time,
        status: String(detail.dispSeatInfo ?? ""),
      });
    }
  }

  return shows;
}

function buildNotificationMessage(show) {
  return [
    "[toall]🎉 チケット戻ったよ！",
    "",
    `公演日：${show.date}`,
    show.time,
    `在庫コード：9 → ${show.status}`,
    "",
    "ページURL",
    LTIKE_URL,
  ].join("\n");
}

async function sendChatworkMessage(text) {
  if (!CHATWORK_TOKEN || !CHATWORK_ROOM_ID) return;
  const roomId = String(CHATWORK_ROOM_ID).trim();
  if (!roomId) return;
  const apiUrl = `https://api.chatwork.com/v2/rooms/${roomId}/messages`;
  const body = new URLSearchParams({ body: text }).toString();
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": CHATWORK_TOKEN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (res.ok) {
    console.log("Chatwork通知送信 OK");
  } else {
    const errBody = await res.text();
    console.error("Chatwork API エラー:", res.status, errBody);
  }
}

async function sendLineMessage(text) {
  if (!LINE_TOKEN || !LINE_USER_ID) return;
  const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: "text", text }],
    }),
  });

  if (lineRes.ok) {
    console.log("LINE通知送信 OK");
  } else {
    const errBody = await lineRes.text();
    console.error("LINE API エラー:", lineRes.status, errBody);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkPage() {
  try {
    let res;
    for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);

      res = await fetch(LTIKE_URL, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "ja",
        },
      });

      clearTimeout(timeout);

      if (res.ok) break;

      if (res.status >= 500 && attempt < FIVE_XX_RETRY_COUNT - 1) {
        console.log("5xx:", res.status, "→", attempt + 2, "/", FIVE_XX_RETRY_COUNT, "回目を", FIVE_XX_RETRY_WAIT_MS / 1000, "秒後にリトライ");
        await sleep(FIVE_XX_RETRY_WAIT_MS);
        continue;
      }

      if (!res.ok) {
        console.log("Fetch failed:", res.status);
        if (res.status >= 500) {
          console.log("今回のチェックはスキップ、次回の間隔で再試行します");
          return;
        }
        throw new Error("Fetch status error");
      }
    }

    const shows = parseShows(await res.text());
    const counts = { 9: 0, 1: 0, 0: 0 };

    for (const show of shows) {
      if (show.status === "9" || show.status === "1" || show.status === "0") {
        counts[show.status] += 1;
      }
      const prev = lastStatus.get(show.key);
      if (prev === SOLDOUT && AVAILABLE.has(show.status)) {
        const message = buildNotificationMessage(show);
        await sendLineMessage(message);
        await sendChatworkMessage(message);
        console.log("通知対象:", show.date, show.time, `9 → ${show.status}`);
      }
      lastStatus.set(show.key, show.status);
    }

    console.log(
      "[ローチケ] Checked at:",
      new Date().toISOString(),
      `9:${counts[9]}`,
      `1:${counts[1]}`,
      `0:${counts[0]}`
    );
    retrying = false;
  } catch (err) {
    console.log("[ローチケ] Fetch timeout or error:", err.message);

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

checkPage().catch(() => {});
scheduleNextCheck();
