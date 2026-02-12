import fetch from "node-fetch";
import express from "express";

const url = "https://eplus.jp/sf/detail/0473460001";
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
        const message = `🎉 チケット販売中！\n${url}`;

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
