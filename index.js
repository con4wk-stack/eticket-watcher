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
function getDetailUrlFromListHtml(html) {
  const blocks = parseAllBlocks(html); // button--primary も button--default も含むブロック
  if (blocks.length === 0) return { url: null };
  const last = blocks[blocks.length - 1];
  const link = last.詳細リンク && last.詳細リンク[0];
  const url = link ? link.replace(/&amp;/g, "&").trim() : null;
  return {
    url,
    公演日: last.公演日,
    公演時間: last.公演時間,
    公演タイトル: last.公演タイトル || "",
  };
}

const DETAIL_FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
};

let lastDetailState = null;

/** レスポンスから Cookie ヘッダ用の文字列を組み立てる（node-fetch v3 / getSetCookie 対応） */
function getCookieHeader(res) {
  let list = [];
  if (typeof res.headers.getSetCookie === "function") {
    list = res.headers.getSetCookie();
  } else if (res.headers.raw && Array.isArray(res.headers.raw["set-cookie"])) {
    list = res.headers.raw["set-cookie"];
  }
  if (list.length === 0) return undefined;
  return list
    .map((s) => s.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * 一覧ページにアクセスしてから詳細ページを取得（「一覧から入り直す」再現）
 * 戻り: { ok, status, html, errorType? } 失敗時は errorType で理由を区別
 */
async function fetchDetailViaList(cookieHeader = undefined) {
  let listRes;
  try {
    const listController = new AbortController();
    const listTimeout = setTimeout(() => listController.abort(), TIMEOUT);
    listRes = await fetch(url, {
      signal: listController.signal,
      headers: DETAIL_FETCH_HEADERS,
      redirect: "follow",
    });
    clearTimeout(listTimeout);
  } catch (e) {
    console.error("[detail] 一覧に戻れなかった（タイムアウト）:", e.message);
    return { ok: false, status: null, html: null, errorType: "list_timeout" };
  }

  if (!listRes.ok) {
    console.error("[detail] 一覧に戻れなかった（HTTP " + listRes.status + "）");
    return { ok: false, status: listRes.status, html: null, errorType: "list_failed" };
  }
  const listHtml = await listRes.text();
  const { url: detailUrl, 公演日, 公演時間, 公演タイトル } = getDetailUrlFromListHtml(listHtml);
  if (!detailUrl) {
    console.log("[detail] 一覧から最後の詳細ボタンのURLを取得できませんでした");
    return { ok: false, status: null, html: null, errorType: "no_detail_link" };
  }
  console.log(
    "[detail] 一番最後のボタン:",
    "block-ticket-article__date=" + 公演日,
    "block-ticket-article__time=" + 公演時間,
    "block-ticket__title=" + 公演タイトル
  );
  console.log("[detail] 一覧の最後のボタンから個別URL取得 → 取得中");

  const cookie = cookieHeader || getCookieHeader(listRes);
  if (!cookie) {
    console.log("[detail] 一覧からCookieを取得できませんでした（403の原因の可能性）");
  }
  const headers = {
    ...DETAIL_FETCH_HEADERS,
    Referer: url,
    Origin: new URL(url).origin,
  };
  if (cookie) headers.Cookie = cookie;

  let detailRes;
  try {
    const detailController = new AbortController();
    const detailTimeout = setTimeout(() => detailController.abort(), TIMEOUT);
    detailRes = await fetch(detailUrl, {
      signal: detailController.signal,
      headers,
      redirect: "follow",
    });
    clearTimeout(detailTimeout);
  } catch (e) {
    console.error("[detail] 一覧から個別ページに入れなかった（タイムアウト）:", e.message);
    return { ok: false, status: null, html: null, errorType: "detail_timeout" };
  }

  const html = await detailRes.text();
  if (!detailRes.ok) {
    console.error("[detail] 一覧から個別ページに入れなかった（HTTP " + detailRes.status + "）");
    if (detailRes.status === 403) {
      console.log("[detail] 403の原因候補: Cookie未取得、Referer/Origin拒否、アクセス制限。一覧と個別が別ドメインのためCookieが渡らない場合があります。");
    }
    return { ok: false, status: detailRes.status, html: null, errorType: "detail_failed" };
  }
  return { ok: true, status: detailRes.status, html };
}

/** 詳細ページの HTML がエラーページかどうか（タイムアウト・セッション切れ等） */
function isDetailErrorPage(html) {
  if (!html || html.length < 500) return true;
  if (/エラー|タイムアウト|セッションが切れ|再度アクセス|ご利用できません/i.test(html)) return true;
  if (!html.includes("ticketDate")) return true; // 正常な一覧なら ticketDate がある
  return false;
}

let detailRetrying = false;

async function checkDetailPage() {
  try {
    let res;
    for (let attempt = 0; attempt < FIVE_XX_RETRY_COUNT; attempt++) {
      if (attempt > 0) {
        console.log("[detail] 5xx:", res && res.status, "→", attempt + 1, "/", FIVE_XX_RETRY_COUNT, "回目を", FIVE_XX_RETRY_WAIT_MS / 1000, "秒後にリトライ");
        await sleep(FIVE_XX_RETRY_WAIT_MS);
      }

      // 一覧を取得 → 最後の「詳細」ボタンのURLを取得 → そのURLで個別ページを取得
      res = await fetchDetailViaList();

      const is5xx = res && res.status >= 500;
      if (res && res.ok) break;
      if (is5xx && attempt < FIVE_XX_RETRY_COUNT - 1) continue;
      break;
    }

    if (!res || !res.ok) {
      if (res && res.status >= 500) {
        console.log("[detail] 今回のチェックはスキップ、次回の間隔で再試行します（HTTP " + res.status + "）");
      } else if (res && res.errorType === "no_detail_link") {
        console.log("[detail] 一覧に詳細ボタンがありません（スキップ）");
      } else if (res && res.errorType) {
        console.error("[detail] タイムアウト復活できませんでした（一覧経由の再試行も失敗）");
      } else {
        console.error("[detail] 詳細ページの取得に失敗（HTTP " + (res ? res.status : "—") + "）");
      }
      return;
    }

    const html = res.html;
    if (isDetailErrorPage(html)) {
      console.error("[detail] 一覧から個別ページに入れなかった（エラーページが表示された）");
      return;
    }

    const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
    const normalTickets = [];
    let rowsWithTicketDate = 0;

    for (const row of rows) {
      const dateMatch = row[1].match(/ticketDate[\s\S]*?>([\s\S]*?)<\/span>/);
      if (!dateMatch) continue;

      rowsWithTicketDate++;
      const date = dateMatch[1].replace(/\s+/g, " ").trim();
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)];
      if (cells.length < 2) continue;

      const normal = cells[0][1];
      // if (normal.includes("○") || normal.includes("△"))
      if (normal.includes("×")) {
        normalTickets.push(date);
      }
    }

    if (rowsWithTicketDate > 0) {
      console.log("[detail] テーブル取得OK: <tr>=" + rows.length + "件, ticketDate付き=" + rowsWithTicketDate + "件, 対象公演日=" + normalTickets.length + "件", normalTickets.length ? "→ " + normalTickets.join(", ") : "");
    } else {
      console.log("[detail] テーブル取得NG: <tr>=" + rows.length + "件, ticketDate付き=0件（正しく取れていません）");
    }

    const state = JSON.stringify(normalTickets);

    if (state !== lastDetailState && normalTickets.length > 0) {
      const message = [
        "🎫 当日引換券が復活！",
        "",
        ...normalTickets,
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
          console.log("detail LINE通知送信:", normalTickets.length, "件");
        } else {
          const errBody = await lineRes.text();
          console.error("detail LINE API エラー:", lineRes.status, errBody);
        }
      }
    }

    lastDetailState = state;
    console.log("detail checked");
    detailRetrying = false;
  } catch (e) {
    console.error("[detail] 予期しないエラー:", e.message);
    if (e.code) console.error("[detail] エラーコード:", e.code);
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

checkDetailPage();
setInterval(checkDetailPage, 15000);
