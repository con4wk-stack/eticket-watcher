import fetch from "node-fetch";
import express from "express";

const url = "https://eplus.jp/sf/detail/0473460001";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "C755fb6ffbd64b76818fd0a4dac5b130f";

const NORMAL_INTERVAL = 30000;
const BATTLE_INTERVAL = 15000;
const RETRY_DELAY = 5000;
const TIMEOUT = 15000;
const FIVE_XX_RETRY_COUNT = 3;   // 5xx 時の同一チェック内リトライ回数
const FIVE_XX_RETRY_WAIT_MS = 15000; // 5xx リトライまでの待機（ミリ秒）

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("Watcher running"));
app.post("/webhook", (req, res) => {
  console.log("Webhook受信:");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));

console.log("Watcher started:", new Date().toISOString());

let retrying = false;
// 各ボタンの前回の状態。key = 公演日-公演時間-詳細リンク → true=primary, false=default
// default→primary になったときだけ通知し、primary→default になったら false に戻す（再販でまた通知できる）
let lastButtonState = new Map();

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
 * ページ内の全ボタン（primary も default も）をブロック単位で取得する。
 * 戻り: { 公演日, 公演時間, 公演タイトル, 詳細リンク, isPrimary }[]
 */
function parseAllBlocks(html) {
  const items = [];
  const detailLinkRe = /window\.location\.href='([^']+)'/g;

  const dateClassRe = /class="[^"]*block-ticket-article__date[^"]*"[^>]*>([\s\S]*?)<\/\w+>/g;
  const timeClassRe = /class="[^"]*block-ticket-article__time[^"]*"[^>]*>([\s\S]*?)<\/\w+>/g;
  const titleClassRe = /class="[^"]*block-ticket__title[^"]*"[^>]*>([\s\S]*?)<\/\w+>/g;

  const blockStarts = [];
  let dm;
  while ((dm = dateClassRe.exec(html)) !== null) {
    blockStarts.push({ index: dm.index, dateText: dm[1].replace(/\s+/g, " ").trim() });
  }

  const MIN_BLOCK_LEN = 3000;
  for (let i = 0; i < blockStarts.length; i++) {
    const blockStart = blockStarts[i].index;
    const nextStart = i + 1 < blockStarts.length ? blockStarts[i + 1].index : html.length;
    const blockEnd = Math.max(nextStart, blockStart + MIN_BLOCK_LEN);
    const block = html.slice(blockStart, Math.min(blockEnd, html.length));

    const hasPrimary = block.includes("button--primary");
    const hasDefault = block.includes("button--default");
    if (!hasPrimary && !hasDefault) continue;

    const 公演日 = blockStarts[i].dateText;
    timeClassRe.lastIndex = 0;
    const timeMatch = timeClassRe.exec(block);
    const 公演時間Raw = timeMatch ? timeMatch[1] : "";
    const 公演時間 = 公演時間Raw.replace(/\s+/g, " ").trim();
    titleClassRe.lastIndex = 0;
    const titleMatch = titleClassRe.exec(block);
    const 公演タイトル = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";

    const links = [];
    const seenUrls = new Set();
    let linkMatch;
    detailLinkRe.lastIndex = 0;
    while ((linkMatch = detailLinkRe.exec(block)) !== null) {
      const href = linkMatch[1].replace(/&amp;/g, "&").trim();
      if (seenUrls.has(href)) continue;
      seenUrls.add(href);
      links.push(href);
    }

    items.push({
      公演日,
      公演時間,
      公演タイトル,
      詳細リンク: links,
      isPrimary: hasPrimary,
    });
  }

  return items;
}

function buildNotificationMessage(item, pageUrl) {
  const lines = [
    "🎉 チケット戻ったよ！🎾",
    "",
    `公演日：${item.公演日}`,
    `${item.公演時間 || "—"}`,
  ];

  for (const link of item.詳細リンク) {
    lines.push(link);
  }

  lines.push("");
  lines.push(`ページURL`);
  lines.push(pageUrl);

  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkPage() {
  try {
    let res;
    for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);

      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

    const html = await res.text();
    const allBlocks = parseAllBlocks(html);

    for (const block of allBlocks) {
      const link = block.詳細リンク.length ? block.詳細リンク[0].replace(/&amp;/g, "&").trim() : "";
      const key = `${block.公演日}-${block.公演時間}-${link}`;
      const wasPrimary = lastButtonState.get(key);

      // default → primary になったときだけ通知（初回も wasPrimary が undefined なので通知）
      if (block.isPrimary && wasPrimary !== true) {
        if (LINE_TOKEN && LINE_USER_ID) {
          const message = buildNotificationMessage(
            { 公演日: block.公演日, 公演時間: block.公演時間, 詳細リンク: block.詳細リンク },
            url
          );

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
            console.log("LINE通知送信:", block.公演日, block.公演時間);
          } else {
            const errBody = await lineRes.text();
            console.error("LINE API エラー:", lineRes.status, errBody);
          }
        }
      }

      lastButtonState.set(key, block.isPrimary);
    }

    // 今回のページに無い key は削除（公演が一覧から消えた場合）
    for (const key of lastButtonState.keys()) {
      const found = allBlocks.some((b) => {
        const l = b.詳細リンク.length ? b.詳細リンク[0].replace(/&amp;/g, "&").trim() : "";
        return `${b.公演日}-${b.公演時間}-${l}` === key;
      });
      if (!found) lastButtonState.delete(key);
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

// ===== 個ページ監視（一覧の「最後の button class="button"」のリンクから個別ページへ） =====
// 最後のボタンは button--default / button--primary で切り替わる。どちらの状態でも同じURLを使う。

/** 一覧HTMLから、最後の詳細ボタンのURLと公演情報を取得。戻り: { url, 公演日, 公演時間, 公演タイトル } or { url: null } */
const DETAIL_URL =
  "https://atom.eplus.jp/sys/main.jsp?prm=U=82:P2=047346:P5=0001:P3=0484:P21=010:P7=13:P6=001:P1=0003:P0=GGWC01:P55=//eplus.jp%2Fsf%2Fdetail%2F0473460001";

const DETAIL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "ja-JP,ja;q=0.9",
  Referer: "https://eplus.jp/",
  "Cache-Control": "no-cache",
};

let lastDetailState = null;

async function checkDetailPage() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT);

    const res = await fetch(DETAIL_URL, {
      headers: DETAIL_HEADERS,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.log("[detail] fetch failed:", res.status);
      return;
    }

    const html = await res.text();

    if (!html.includes("ticketDate")) {
      console.log("[detail] ページ取得失敗（テーブル無し）");
      return;
    }

    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];

    const availableDates = [];

    for (const row of rows) {
      const dateMatch = row[1].match(/ticketDate[\s\S]*?>([\s\S]*?)<\/span>/);

      if (!dateMatch) continue;

      const date = dateMatch[1].replace(/\s+/g, " ").trim();

      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];

      if (cells.length < 2) continue;

      const normal = cells[0][1];

      // 当日引換券 在庫チェック
      if (normal.includes("○") || normal.includes("△")) {
        availableDates.push(date);
      }
    }

    const state = JSON.stringify(availableDates);

    if (state !== lastDetailState && availableDates.length > 0) {
      const message = [
        "🎫 当日引換券が復活！",
        "",
        ...availableDates,
        "",
        url,
      ].join("\n");

      if (LINE_TOKEN && LINE_USER_ID) {
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
          console.log("[detail] LINE通知送信:", availableDates.length);
        } else {
          const err = await lineRes.text();
          console.log("[detail] LINEエラー:", err);
        }
      }
    }

    lastDetailState = state;

    console.log("[detail] checked:", new Date().toISOString());

  } catch (e) {
    console.log("[detail] error:", e.message);
  }
}

setInterval(checkDetailPage, 30000);