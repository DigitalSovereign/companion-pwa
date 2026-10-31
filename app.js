const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SKEY = "companion.settings";
const QKEY = "companion.qstatus";
let SYSTEM = "";

/* ---------- settings ---------- */
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SKEY) || "{}"); } catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SKEY, JSON.stringify(s)); }

function fillSettings() {
  const s = getSettings();
  $("key").value = s.key || "";
  $("base").value = s.base || "https://api.deepseek.com";
  $("model").value = s.model || "deepseek-chat";
}
function applySettings() {
  const s = { key: $("key").value.trim(), base: $("base").value.trim() || "https://api.deepseek.com", model: $("model").value.trim() || "deepseek-chat" };
  saveSettings(s);
  $("settings").classList.add("hidden");
  $("err").textContent = "";
  $("mode").textContent = s.key ? "云端 · 已配置" : "云端 · 未配置";
}
function toggleSettings() {
  $("settings").classList.toggle("hidden");
  fillSettings();
}

/* ---------- indexeddb ---------- */
let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const req = indexedDB.open("companion", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("items")) {
        const s = d.createObjectStore("items", { keyPath: "id", autoIncrement: true });
        s.createIndex("created", "created");
      }
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbp;
}
async function addItem(item) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction("items", "readwrite");
    const req = tx.objectStore("items").add(item);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function allItems() {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction("items", "readonly");
    const req = tx.objectStore("items").getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => rej(req.error);
  });
}

/* ---------- ask ---------- */
function fmtTime(t) { return new Date(t).toLocaleString("zh-CN", { hour12: false }); }

async function ask() {
  const q = $("q").value.trim();
  if (!q) return;
  const s = getSettings();
  if (!s.key) { $("settings").classList.remove("hidden"); fillSettings(); $("err").textContent = "先填 API Key（存在本机浏览器里）"; return; }

  const base = (s.base || "https://api.deepseek.com").replace(/\/+$/, "");
  const model = s.model || "deepseek-chat";
  const depth = $("depth").value;
  const stance = $("stance").value;
  const ctx = $("ctx").value.trim();

  const user = ctx ? `【当前阅读 / 选中】\n${ctx}\n\n【问题】\n${q}` : q;
  const sys = SYSTEM || "你是我的伴读老师。用中文回答；标明不确定；给出来源层级。";

  $("ask").disabled = true;
  $("err").textContent = "";
  $("answer").textContent = "思考中…（深答通常 20—60 秒）";
  $("copylines").innerHTML = "";

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: `${sys}\n\n## 本次设定\n深度：${depth}\n立场：${stance}` },
          { role: "user", content: user },
        ],
        temperature: 0.3,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`接口 ${res.status}：${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const answer = (data?.choices?.[0]?.message?.content || "").trim();
    if (!answer) throw new Error("返回为空");
    $("answer").textContent = answer;

    const m = answer.match(/【抄写版】\s*([^\n]+)/);
    if (m) {
      $("copylines").innerHTML = `<div class="copyline">${esc(m[1])}</div>`;
    }
    await addItem({ kind: "session", created: Date.now(), question: q, answer, depth, stance });
    renderInbox();
  } catch (e) {
    $("answer").textContent = "";
    $("err").textContent = String(e.message || e);
  } finally {
    $("ask").disabled = false;
  }
}

/* ---------- capture ---------- */
async function capture() {
  const text = $("note").value.trim();
  if (!text) return;
  await addItem({
    kind: "capture",
    created: Date.now(),
    text,
    source: $("source").value,
    page: $("page").value.trim(),
  });
  $("note").value = "";
  $("capmeta").textContent = "已存";
  renderInbox();
}

async function renderInbox() {
  const items = (await allItems()).filter((i) => i.kind === "capture").sort((a, b) => b.created - a.created).slice(0, 5);
  $("inbox").innerHTML = items.length
    ? items.map((i) => `<div class="item"><div class="t">${esc(fmtTime(i.created))} · ${esc(i.source)}${i.page ? " · " + esc(i.page) : ""}</div>${esc(i.text)}</div>`).join("")
    : '<div class="meta">还没有记录。</div>';
  const all = await allItems();
  $("count").textContent = `本地已存 ${all.length} 条（捕获 ${all.filter((i) => i.kind === "capture").length} / 问答 ${all.filter((i) => i.kind === "session").length}）`;
}

/* ---------- export ---------- */
async function exportAll() {
  const items = (await allItems()).sort((a, b) => a.created - b.created);
  if (!items.length) { $("capmeta").textContent = "没有可导出的内容"; return; }
  let md = `# 伴读导出 ${new Date().toISOString().slice(0, 10)}\n\n`;
  for (const it of items) {
    if (it.kind === "capture") {
      md += `## 捕获 ${fmtTime(it.created)} · ${it.source}${it.page ? " · " + it.page : ""}\n\n${it.text}\n\n`;
    } else if (it.kind === "session") {
      md += `## 问答 ${fmtTime(it.created)} · ${it.depth}/${it.stance}\n\n**问**：${it.question}\n\n**答**：\n\n${it.answer}\n\n`;
    }
  }
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `companion-export-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- questions ---------- */
async function loadQuestions() {
  let qs = [];
  try { qs = await (await fetch("questions.json")).json(); } catch { qs = []; }
  const status = JSON.parse(localStorage.getItem(QKEY) || "{}");
  $("questions").innerHTML = qs.map((q) => {
    const st = status[q.id] || "open";
    return `<div class="q"><span class="pill">${esc(q.id)}</span> ${esc(q.question)} <button class="ghost small" data-qid="${esc(q.id)}">${esc(st)}</button></div>`;
  }).join("") || '<div class="meta">问题清单加载失败。</div>';
  $("questions").querySelectorAll("button[data-qid]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.qid;
      const st = JSON.parse(localStorage.getItem(QKEY) || "{}");
      const order = ["open", "partial", "answered"];
      st[id] = order[(order.indexOf(st[id] || "open") + 1) % order.length];
      localStorage.setItem(QKEY, JSON.stringify(st));
      loadQuestions();
    });
  });
}

/* ---------- init ---------- */
$("ask").addEventListener("click", ask);
$("capture").addEventListener("click", capture);
$("save").addEventListener("click", applySettings);
$("gear").addEventListener("click", toggleSettings);
$("export").addEventListener("click", exportAll);
$("q").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") ask(); });

fetch("prompt.txt").then((r) => r.text()).then((t) => { SYSTEM = t; }).catch(() => {});
fillSettings();
renderInbox();
loadQuestions();

const s = getSettings();
$("mode").textContent = s.key ? "云端 · 已配置" : "云端 · 未配置";
if (!s.key) { $("settings").classList.remove("hidden"); }

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
