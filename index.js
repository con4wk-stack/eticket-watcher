import fetch from "node-fetch";
import express from "express";

const url = "https://eplus.jp/sf/detail/0473460001";
const LINE_TOKEN = "53HSL37fngc+EuTIdX2tBlWHdwb4evtfo1ZRLb1XK1uETtS9FeBOLqHVCUQvO7YVssWAI/W1NfQ8yUPVIuQFY7425HbkBwzLmj2Ljt7zT0xcNhKgcNj/P5C631nktl1O44WQb2m+JLWQ/lF+CYUdxQdB04t89/1O/w1cDnyilFU=";
const LINE_USER_ID = "C755fb6ffbd64b76818fd0a4dac5b130f";
// Chatwork（常にLINEとChatworkの両方に送信）。環境変数 CHATWORK_TOKEN / CHATWORK_ROOM_ID か、下記に直接指定。空ならChatworkは送らない
// ルームIDは「数字だけ」か「ルームURL」（#!rid の後ろの数字を自動抽出）
const _cwRoomRaw = (process.env.CHATWORK_ROOM_ID || "rid425373870").trim();
const CHATWORK_TOKEN = (process.env.CHATWORK_TOKEN || "f03fec5446114f0da54c391afcbab29e").trim();
const CHATWORK_ROOM_ID = _cwRoomRaw.match(/rid(\d+)/)?.[1] || _cwRoomRaw.replace(/\D/g, "") || "";



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

/** Chatwork にメッセージを送信（TOKEN と ROOM_ID が設定されている場合のみ） */
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
        const message = buildNotificationMessage(
          { 公演日: block.公演日, 公演時間: block.公演時間, 詳細リンク: block.詳細リンク },
          url
        );

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
            console.log("LINE通知送信:", block.公演日, block.公演時間);
          } else {
            const errBody = await lineRes.text();
            console.error("LINE API エラー:", lineRes.status, errBody);
          }
        }
        await sendChatworkMessage(message);
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

// ===== 個ページ監視（一覧の「最後のボタン」をクリックして詳細へ遷移） =====
/**
 * 一覧HTMLから、最後の詳細ボタンの onclick 内 window.location.href='URL' を抽出。
 * 通知仕様は変更しない（通知URL＝一覧ページのみ。詳細URLは内部チェック専用）。
 */
function getDetailUrlFromListHtml(html) {
  const blocks = parseAllBlocks(html);
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;

  let onclickValue = null;
  let detailUrl = null;
  const onclickRe = /onclick="([^"]*?window\.location\.href='([^']+)'[^"]*)"/g;
  let m;
  while ((m = onclickRe.exec(html)) !== null) {
    onclickValue = m[1];
    detailUrl = m[2].replace(/&amp;/g, "&").trim();
  }

  return {
    url: detailUrl,
    onclickValue: onclickValue || undefined,
    公演日: last ? last.公演日 : "",
    公演時間: last ? last.公演時間 : "",
    公演タイトル: last ? last.公演タイトル || "" : "",
  };
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const DETAIL_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  Referer: url,
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "DNT": "1",
};

let lastDetailState = null;
let detailRetrying = false;

/**
 * 一覧レスポンスで受け取った Cookie を次のリクエスト用の文字列にまとめる
 */
function getCookieHeaderFromResponse(listRes) {
  const setCookie = listRes.headers.get("set-cookie") ?? listRes.headers.get("Set-Cookie");
  if (setCookie) return setCookie;
  if (typeof listRes.headers.getSetCookie === "function") {
    return listRes.headers.getSetCookie().join("; ");
  }
  return "";
}

/**
 * fetch で一覧→詳細の順にアクセス（一覧で取得した Cookie + Referer で「ボタンクリック相当」の遷移）
 */
async function fetchDetailHtmlWithFetch(listUrl, detailUrl, listRes) {
  const cookieHeader = getCookieHeaderFromResponse(listRes);
  const headers = { ...DETAIL_HEADERS, Referer: listUrl };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);
  const res = await fetch(detailUrl, {
    signal: controller.signal,
    headers,
  });
  clearTimeout(timeout);

  if (!res.ok) {
    throw new Error(`detail fetch ${res.status}`);
  }
  return res.text();
}

async function checkDetailPage() {
  try {
    let html = "";
    let detailUrl = null;

    // アクセス順序: 一覧 → 詳細（一覧で Cookie/Referer を取得し、詳細は「クリック相当」で fetch）
    for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
      if (attempt > 0) {
        console.log(
          "[detail] 403/5xx のため一覧に戻ってセッション更新し再試行:",
          attempt + 1,
          "/",
          FIVE_XX_RETRY_COUNT,
          "回目を",
          FIVE_XX_RETRY_WAIT_MS / 1000,
          "秒後"
        );
        await sleep(FIVE_XX_RETRY_WAIT_MS);
      }

      // 1. 一覧ページにアクセス（Cookie/セッション取得）
      const listController = new AbortController();
      const listTimeout = setTimeout(() => listController.abort(), TIMEOUT);
      const listRes = await fetch(url, {
        signal: listController.signal,
        headers: DETAIL_HEADERS,
      });
      clearTimeout(listTimeout);

      if (!listRes.ok) {
        console.log("[detail] 一覧取得失敗:", listRes.status);
        return;
      }

      const listHtml = await listRes.text();

      const { url: extractedUrl, onclickValue, 公演日, 公演時間, 公演タイトル } =
        getDetailUrlFromListHtml(listHtml);

      if (!extractedUrl) {
        console.log("[detail] 一覧から最後の詳細ボタンのURLを取得できませんでした");
        return;
      }

      detailUrl = extractedUrl;
      console.log("[detail] onclick:", onclickValue ?? "(なし)");
      console.log("[detail] extracted url:", detailUrl);
      if (detailUrl.includes("sp.atom.eplus.jp")) {
        detailUrl = detailUrl.replace("sp.atom.eplus.jp", "atom.eplus.jp");
      }
      console.log("[detail] fixed url (PC版):", detailUrl);

      console.log(
        "[detail] 一番最後のボタン（クリック相当で遷移）:",
        "date=" + 公演日,
        "time=" + 公演時間,
        "title=" + 公演タイトル
      );

      // 2. 一覧の Cookie + Referer で詳細ページを fetch（ボタンクリック相当）
      try {
        html = await fetchDetailHtmlWithFetch(url, detailUrl, listRes);
        console.log("[detail] status: 200 (fetch)");
        break;
      } catch (e) {
        console.log("[detail] fetch error:", e.message);
        if (attempt < FIVE_XX_RETRY_COUNT - 1) continue;
        html = "";
        break;
      }
    }

    if (!html) {
      console.log("[detail] 詳細ページの取得に失敗しました。次回の間隔で再試行します。");
      return;
    }

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
      await sendChatworkMessage(message);
    }

    lastDetailState = state;

    console.log("[detail] checked:", new Date().toISOString());
    detailRetrying = false;
  } catch (e) {
    console.log("[detail] error:", e.message);
    if (!detailRetrying) {
      detailRetrying = true;
      console.log("[detail]", RETRY_DELAY / 1000, "秒後に再試行します");
      setTimeout(() => {
        checkDetailPage().finally(() => {
          detailRetrying = false;
        });
      }, RETRY_DELAY);
    }
  }
}

checkDetailPage().catch((e) => console.error("[detail] startup error:", e.message));
setInterval(() => checkDetailPage().catch((e) => console.error("[detail] interval error:", e.message)), 30000);