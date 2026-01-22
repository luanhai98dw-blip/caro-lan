let ws = null;
let connected = false;

let roomCode = null;
let myRole = null;     // "player" | "spectator"
let mySymbol = 0;      // 1:X 2:O
let state = null;

const $ = (id) => document.getElementById(id);

const elStatus = $("status");
const elBoard = $("board");
const elPeople = $("people");
const elChatbox = $("chatbox");
const elMeInfo = $("meInfo");

function setStatus(text) {
  elStatus.textContent = text;
}

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
  div.innerHTML = `<span class="t">[${ts}]</span><span class="n">${escapeHtml(name)}:</span>${escapeHtml(text)}`;
  elChatbox.appendChild(div);
  elChatbox.scrollTop = elChatbox.scrollHeight;
}

function escapeHtml(s){
  return (s||"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

function send(type, data) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type, data }));
}

// ====== board render ======
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

  // reset win highlight
  const winSet = new Set();
  if (state.winLine && Array.isArray(state.winLine)) {
    for (const p of state.winLine) winSet.add(`${p.x},${p.y}`);
  }

  const cells = elBoard.querySelectorAll(".cell");
  cells.forEach(cell => {
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    const v = state.board[y][x];

    cell.textContent = v === 1 ? "X" : (v === 2 ? "O" : "");
    cell.classList.toggle("win", winSet.has(`${x},${y}`));

    // giảm hover nếu không được đánh
    cell.style.opacity = "1";
  });

  const turn = state.turn === 1 ? "X" : "O";
  if (state.status === "waiting") setStatus(`Đang chờ người chơi thứ 2... (Phòng: ${state.code})`);
  if (state.status === "playing") setStatus(`Đang chơi • Lượt: ${turn} • Phòng: ${state.code}`);
  if (state.status === "ended") {
    if (state.winner === 0) setStatus(`Ván kết thúc • Phòng: ${state.code}`);
    else setStatus(`🏆 ${state.winner === 1 ? "X" : "O"} thắng • Phòng: ${state.code}`);
  }

  // info của mình
  if (myRole === "player") {
    elMeInfo.textContent = `Bạn: ${mySymbol === 1 ? "X" : "O"} (${roomCode})`;
  } else if (myRole === "spectator") {
    elMeInfo.textContent = `Bạn đang xem (${roomCode})`;
  } else {
    elMeInfo.textContent = "Bạn: -";
  }

  // people list
  renderPeople();
}

function renderPeople() {
  if (!state) return;
  elPeople.innerHTML = "";

  const players = state.players || [];
  const specs = state.spectators || [];

  players.forEach(p => {
    const b = document.createElement("div");
    b.className = "badge";
    const sym = p.symbol === 1 ? "X" : "O";
    b.innerHTML = `<div><b>${escapeHtml(p.name)}</b> <small>(${sym})</small></div>`;
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

function onCellClick(x, y) {
  if (!state) return;
  if (myRole !== "player") return appendChatLine("⚠️ Bạn đang xem, không được đánh.");
  if (state.status !== "playing") return;

  // chỉ cho đánh đúng lượt
  if (state.turn !== mySymbol) return appendChatLine("⚠️ Chưa tới lượt bạn.");

  send("move", { x, y });
}

// ====== WS connect ======
function connect() {
  const name = ($("name").value || "").trim() || "Người chơi";
  $("name").value = name;

  // host input dạng "ip:port" hoặc rỗng => dùng location.host
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

    if (type === "welcome") {
      appendChatLine("📌 " + (data.note || ""));
      return;
    }

    if (type === "hello_ok") {
      appendChatLine(`👋 Xin chào, ${data.name} (${data.id})`);
      return;
    }

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
      appendChatLine(`✅ Vào phòng ${roomCode} thành công (${myRole}${mySymbol ? " - " + (mySymbol===1?"X":"O") : ""})`);
      return;
    }

    if (type === "left") {
      roomCode = null; myRole = null; mySymbol = 0; state = null;
      appendChatLine("👋 Đã rời phòng.");
      setStatus("Bạn đã rời phòng. Tạo/Vào phòng khác.");
      paintBoard();
      return;
    }

    if (type === "system") {
      appendChatLine(data.text || "");
      return;
    }

    if (type === "chat") {
      appendChatObj(data.ts || "--:--:--", data.name || "?", data.text || "");
      return;
    }

    if (type === "state") {
      state = data;
      buildBoard();       // rebuild để tránh lỗi khi reload
      paintBoard();
      return;
    }

    if (type === "error") {
      appendChatLine("❌ " + (data.message || "Lỗi"));
      return;
    }
  };

  ws.onclose = () => {
    connected = false;
    enableUI(false);
    setStatus("Mất kết nối.");
    appendChatLine("❌ Mất kết nối server.");
    roomCode = null; myRole = null; mySymbol = 0; state = null;
  };
}

// ====== buttons ======
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

// init
enableUI(false);
buildBoard();
setStatus("Chưa kết nối");
appendChatLine("👉 Nhập tên + host (nếu cần) rồi bấm Kết nối.");
