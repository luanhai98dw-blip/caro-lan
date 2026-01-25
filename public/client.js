let ws = null;
let connected = false;

let roomCode = null;
let myRole = null;     // "player" | "spectator"
let mySymbol = 0;      // 1:X 2:O 3:▲
let state = null;

let uiTimer = null;

const $ = (id) => document.getElementById(id);

const elStatus = $("status");
const elBoard = $("board");
const elPeople = $("people");
const elChatbox = $("chatbox");
const elMeInfo = $("meInfo");
const elTurnInfo = $("turnInfo");
const elScoreBody = $("scoreBody");

function setStatus(text) { elStatus.textContent = text; }

function enableUI(on) {
  $("btnConnect").disabled = on;
  $("btnDisconnect").disabled = !on;

  $("name").disabled = on;
  $("host").disabled = on;

  $("btnCreate").disabled = !on;
  $("btnJoin").disabled = !on;
  $("btnLeave").disabled = !on;

  $("chatInput").disabled = !on;
  $("btnSend").disabled = !on;

  $("btnRestart").disabled = !on;
}

function escapeHtml(s){
  return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

function appendChatLine(text) {
  const div = document.createElement("div");
  div.className = "msg";
  div.textContent = text;
  elChatbox.appendChild(div);
  elChatbox.scrollTop = elChatbox.scrollHeight;
}

function appendChatObj(ts, name, text) {
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<span class="t">[${escapeHtml(ts)}]</span><span class="n">${escapeHtml(name)}:</span>${escapeHtml(text)}`;
  elChatbox.appendChild(div);
  elChatbox.scrollTop = elChatbox.scrollHeight;
}

function send(type, data) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, data }));
}

function symToText(sym) {
  if (sym === 1) return "X";
  if (sym === 2) return "O";
  if (sym === 3) return "▲";
  return "";
}

/* ====== BOARD ====== */
function buildBoard() {
  elBoard.innerHTML = "";
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      const c = document.createElement("div");
      c.className = "cell";
      c.dataset.x = x;
      c.dataset.y = y;
      c.onclick = () => onCellClick(x, y);
      elBoard.appendChild(c);
    }
  }
}

function paintBoard() {
  if (!state) return;

  const winSet = new Set();
  if (state.winLine && Array.isArray(state.winLine)) {
    for (const p of state.winLine) winSet.add(`${p.x},${p.y}`);
  }

  const last = state.lastMove ? `${state.lastMove.x},${state.lastMove.y}` : null;

  const cells = elBoard.querySelectorAll(".cell");
  cells.forEach(cell => {
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const v = state.board[y][x];

    cell.textContent = symToText(v);
    cell.classList.toggle("win", winSet.has(`${x},${y}`));
    cell.classList.toggle("last", last === `${x},${y}`);
  });

  if (state.status === "waiting") setStatus(`Đang chờ đủ người (tối thiểu 2, tối đa 3)... • Phòng: ${state.code}`);
  if (state.status === "playing") setStatus(`Đang chơi • Phòng: ${state.code}`);
  if (state.status === "ended") {
    if (state.winnerSymbol === 0) setStatus(`Ván kết thúc • Phòng: ${state.code}`);
    else setStatus(`🏆 ${symToText(state.winnerSymbol)} thắng • Phòng: ${state.code}`);
  }

  if (myRole === "player") elMeInfo.textContent = `Bạn: ${symToText(mySymbol)} (${roomCode})`;
  else if (myRole === "spectator") elMeInfo.textContent = `Bạn đang xem (${roomCode})`;
  else elMeInfo.textContent = "Bạn: -";

  if (state.status === "playing") {
    elTurnInfo.textContent = `Lượt: ${symToText(state.turnSymbol)} • Người: ${state.turnPlayerName}`;
  } else {
    elTurnInfo.textContent = `Lượt: -`;
  }

  renderPeople();
  renderScores();
}

function renderPeople() {
  if (!state) return;
  elPeople.innerHTML = "";

  const players = state.players || [];
  const specs = state.spectators || [];

  players.forEach(p => {
    const b = document.createElement("div");
    b.className = "badge";
    const me = (myRole === "player" && mySymbol === p.symbol) ? " (Bạn)" : "";
    b.innerHTML = `<div><b>${escapeHtml(p.name)}</b> <small>(${symToText(p.symbol)})${me}</small></div>`;
    elPeople.appendChild(b);
  });

  if (specs.length) {
    const title = document.createElement("div");
    title.style.opacity = ".8";
    title.style.marginTop = "8px";
    title.textContent = "Người xem:";
    elPeople.appendChild(title);

    specs.forEach(s => {
      const b = document.createElement("div");
      b.className = "badge";
      b.innerHTML = `<div>${escapeHtml(s.name)} <small>(xem)</small></div>`;
      elPeople.appendChild(b);
    });
  }
}

function renderScores() {
  if (!state || !elScoreBody) return;
  const scores = state.scores || [];

  // sort theo wins giảm dần
  scores.sort((a,b) => (b.wins||0) - (a.wins||0));

  if (!scores.length) {
    elScoreBody.innerHTML = `<tr><td colspan="3" style="opacity:.7;">Chưa có dữ liệu</td></tr>`;
    return;
  }

  const myId = (myRole === "player" && state.players)
    ? (state.players.find(p => p.symbol === mySymbol)?.id || "")
    : "";

  elScoreBody.innerHTML = "";
  for (const s of scores) {
    const tr = document.createElement("tr");
    if (myId && s.id === myId) tr.classList.add("scoreMe");
    tr.innerHTML = `
      <td>${escapeHtml(s.name)}</td>
      <td>${escapeHtml(symToText(s.symbol))}</td>
      <td>${escapeHtml(String(s.wins ?? 0))}</td>
    `;
    elScoreBody.appendChild(tr);
  }
}

function onCellClick(x, y) {
  if (!state) return;
  if (myRole !== "player") return appendChatLine("⚠️ Bạn đang xem, không được đánh.");
  if (state.status !== "playing") return;

  if (state.turnSymbol !== mySymbol) return appendChatLine("⚠️ Chưa tới lượt bạn.");

  send("move", { x, y });
}

/* ====== TIMER UI (15s) ====== */
function stopUiTimer() {
  if (uiTimer) {
    clearInterval(uiTimer);
    uiTimer = null;
  }
}

function setTimerUI(activeSymbol, secLeft) {
  const a1 = $("t1"), a2 = $("t2"), a3 = $("t3");
  a1.classList.toggle("active", activeSymbol === 1);
  a2.classList.toggle("active", activeSymbol === 2);
  a3.classList.toggle("active", activeSymbol === 3);

  $("time1").textContent = activeSymbol === 1 ? String(secLeft) : "--";
  $("time2").textContent = activeSymbol === 2 ? String(secLeft) : "--";
  $("time3").textContent = activeSymbol === 3 ? String(secLeft) : "--";
}

function startUiTimerFromState() {
  stopUiTimer();
  if (!state || state.status !== "playing" || !state.turnDeadline) {
    setTimerUI(0, 0);
    return;
  }

  uiTimer = setInterval(() => {
    if (!state || state.status !== "playing") {
      stopUiTimer();
      setTimerUI(0, 0);
      return;
    }

    const msLeft = state.turnDeadline - Date.now();
    const secLeft = Math.max(0, Math.ceil(msLeft / 1000));
    setTimerUI(state.turnSymbol, secLeft);
  }, 200);
}

/* ====== WS ====== */
function connect() {
  const name = ($("name").value || "").trim() || "Người chơi";
  $("name").value = name;

  const hostInput = ($("host").value || "").trim();
  const host = hostInput.length ? hostInput : window.location.host;

  ws = new WebSocket(`ws://${host}`);

  ws.onopen = () => {
    connected = true;
    enableUI(true);
    setStatus("Đã kết nối server. Bạn có thể Tạo phòng hoặc Vào phòng.");
    appendChatLine("✅ Đã kết nối server.");
    send("hello", { name });
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const type = msg.type;
    const data = msg.data || {};

    if (type === "welcome") return appendChatLine("📌 " + (data.note || ""));
    if (type === "hello_ok") return appendChatLine(`👋 Xin chào, ${data.name} (${data.id})`);

    if (type === "room_created") {
      roomCode = data.code;
      $("roomCode").value = roomCode;
      appendChatLine("🏠 Đã tạo phòng: " + roomCode);
      return;
    }

    if (type === "join_ok") {
      roomCode = data.code;
      myRole = data.role;
      mySymbol = data.symbol || 0;
      appendChatLine(`✅ Vào phòng ${roomCode} (${myRole}${mySymbol ? " - " + symToText(mySymbol) : ""})`);
      return;
    }

    if (type === "left") {
      roomCode = null; myRole = null; mySymbol = 0; state = null;
      appendChatLine("👋 Đã rời phòng.");
      setStatus("Bạn đã rời phòng. Tạo/Vào phòng khác.");
      buildBoard();
      stopUiTimer();
      setTimerUI(0, 0);
      if (elScoreBody) elScoreBody.innerHTML = `<tr><td colspan="3" style="opacity:.7;">Chưa có dữ liệu</td></tr>`;
      return;
    }

    if (type === "system") return appendChatLine(data.text || "");

    if (type === "chat") {
      return appendChatObj(data.ts || "--:--:--", data.name || "?", data.text || "");
    }

    if (type === "state") {
      state = data;
      buildBoard();
      paintBoard();
      startUiTimerFromState();
      return;
    }

    if (type === "error") return appendChatLine("❌ " + (data.message || "Lỗi"));
  };

  ws.onclose = () => {
    connected = false;
    enableUI(false);
    setStatus("Mất kết nối.");
    appendChatLine("❌ Mất kết nối server.");
    roomCode = null; myRole = null; mySymbol = 0; state = null;
    stopUiTimer();
    setTimerUI(0, 0);
  };
}

/* ====== BUTTONS ====== */
$("btnConnect").onclick = () => connect();
$("btnDisconnect").onclick = () => { if (ws) ws.close(); };

$("btnCreate").onclick = () => send("create_room", {});
$("btnJoin").onclick = () => {
  const code = ($("roomCode").value || "").trim().toUpperCase();
  if (!code) return appendChatLine("⚠️ Nhập mã phòng trước.");
  send("join_room", { code });
};

$("btnLeave").onclick = () => send("leave_room", {});
$("btnRestart").onclick = () => send("restart", {});

$("btnSend").onclick = () => {
  const t = ($("chatInput").value || "").trim();
  if (!t) return;
  $("chatInput").value = "";
  send("chat", { text: t });
};
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btnSend").click();
});

/* INIT */
enableUI(false);
buildBoard();
setStatus("Chưa kết nối");
appendChatLine("👉 Nhập tên + (host nếu cần) rồi bấm Kết nối.");
setTimerUI(0, 0);
