const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = 3000;
const BOARD_SIZE = 15;
const WIN_COUNT = 5;

const TURN_SECONDS = 15;
const MAX_PLAYERS = 3;

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

function makeEmptyBoard() {
  const b = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    const row = [];
    for (let x = 0; x < BOARD_SIZE; x++) row.push(0);
    b.push(row);
  }
  return b;
}

function genCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function send(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcastRoom(room, obj) {
  room.players.forEach(p => send(p.ws, obj));
  room.spectators.forEach(s => send(s.ws, obj));
}

function inside(x, y) {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function checkWin(board, x, y, symbol) {
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 1 },
    { dx: 1, dy: -1 }
  ];

  for (const d of dirs) {
    const line = [{ x, y }];

    let nx = x + d.dx, ny = y + d.dy;
    while (inside(nx, ny) && board[ny][nx] === symbol) {
      line.push({ x: nx, y: ny });
      nx += d.dx; ny += d.dy;
    }

    nx = x - d.dx; ny = y - d.dy;
    while (inside(nx, ny) && board[ny][nx] === symbol) {
      line.unshift({ x: nx, y: ny });
      nx -= d.dx; ny -= d.dy;
    }

    if (line.length >= WIN_COUNT) return line.slice(0, WIN_COUNT);
  }
  return null;
}

function roomState(room) {
  const turnPlayer = (room.players.length > 0 && room.status === "playing")
    ? room.players[room.turnIndex]
    : null;

  const scores = room.players.map(p => ({
    id: p.id,
    name: p.name,
    symbol: p.symbol,
    wins: room.scoreboard.get(p.id) || 0
  }));

  return {
    code: room.code,
    status: room.status,
    board: room.board,
    players: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })),
    spectators: room.spectators.map(s => ({ id: s.id, name: s.name })),
    winnerSymbol: room.winnerSymbol,
    winnerId: room.winnerId || "",
    winLine: room.winLine,
    turnIndex: room.turnIndex,
    turnSymbol: turnPlayer ? turnPlayer.symbol : 0,
    turnPlayerId: turnPlayer ? turnPlayer.id : "",
    turnPlayerName: turnPlayer ? turnPlayer.name : "",
    turnDeadline: room.turnDeadline || 0,
    lastMove: room.lastMove,
    scores
  };
}

function findRoomOfWs(ws) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.ws === ws)) return room;
    if (room.spectators.some(s => s.ws === ws)) return room;
  }
  return null;
}

function getUserInRoom(room, ws) {
  const p = room.players.find(x => x.ws === ws);
  if (p) return { role: "player", user: p };
  const s = room.spectators.find(x => x.ws === ws);
  if (s) return { role: "spectator", user: s };
  return null;
}

function stopRoomTimer(room) {
  if (room.timerHandle) {
    clearTimeout(room.timerHandle);
    room.timerHandle = null;
  }
}

function startRoomTimer(room) {
  stopRoomTimer(room);
  if (room.status !== "playing" || room.players.length < 2) return;

  room.turnDeadline = Date.now() + TURN_SECONDS * 1000;
  room.timerHandle = setTimeout(() => {
    advanceTurn(room, true);
  }, TURN_SECONDS * 1000);
}

function advanceTurn(room, isTimeout) {
  if (room.status !== "playing" || room.players.length < 2) return;

  const current = room.players[room.turnIndex];
  room.turnIndex = (room.turnIndex + 1) % room.players.length;

  if (isTimeout) {
    broadcastRoom(room, {
      type: "system",
      data: { text: `⏰ ${current.name} hết 15s, tự động mất lượt.` }
    });
  }

  startRoomTimer(room);
  broadcastRoom(room, { type: "state", data: roomState(room) });
}

function resetGame(room) {
  room.board = makeEmptyBoard();
  room.winLine = null;
  room.lastMove = null;

  // Nếu chưa đủ người thì chờ
  if (room.players.length < 2) {
    room.status = "waiting";
    room.winnerSymbol = 0;
    room.winnerId = "";
    stopRoomTimer(room);
    return;
  }

  room.status = "playing";

  // ✅ Winner starts: nếu có winnerId và winner còn trong room => turnIndex = winner
  let startIndex = 0;
  if (room.winnerId) {
    const idx = room.players.findIndex(p => p.id === room.winnerId);
    if (idx >= 0) startIndex = idx;
  }
  room.turnIndex = startIndex;

  // reset winner cho ván mới (nhưng giữ scoreboard)
  room.winnerSymbol = 0;
  room.winnerId = "";

  startRoomTimer(room);
}

function leaveRoom(room, ws, isDisconnect = false) {
  const pi = room.players.findIndex(p => p.ws === ws);
  if (pi >= 0) {
    const p = room.players[pi];
    room.players.splice(pi, 1);

    broadcastRoom(room, {
      type: "system",
      data: { text: `🔴 ${p.name} đã rời phòng${isDisconnect ? " (mất kết nối)" : ""}.` }
    });

    // nếu đang chơi mà player rời -> kết thúc ván
    if (room.status === "playing") {
      room.status = "ended";
      room.winnerSymbol = 0;
      room.winnerId = "";
      room.winLine = null;
      stopRoomTimer(room);
      broadcastRoom(room, { type: "system", data: { text: "⚠️ Ván kết thúc do có người thoát." } });
    }
  }

  const si = room.spectators.findIndex(s => s.ws === ws);
  if (si >= 0) {
    const s = room.spectators[si];
    room.spectators.splice(si, 1);
    broadcastRoom(room, { type: "system", data: { text: `👋 ${s.name} ngừng xem.` } });
  }

  if (room.players.length === 0 && room.spectators.length === 0) {
    stopRoomTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (room.turnIndex >= room.players.length) room.turnIndex = 0;

  if (room.players.length < 2) {
    room.status = "waiting";
    stopRoomTimer(room);
  }

  broadcastRoom(room, { type: "state", data: roomState(room) });
}

wss.on("connection", (ws) => {
  ws._id = "U" + Math.random().toString(16).slice(2, 8).toUpperCase();
  ws._name = "Người chơi";

  send(ws, { type: "welcome", data: { note: "Chào mừng bạn đến CARO LAN (tối đa 3 người chơi)!" } });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); }
    catch { return send(ws, { type: "error", data: { message: "JSON không hợp lệ." } }); }

    const type = msg.type;
    const data = msg.data || {};

    if (type === "hello") {
      const name = (data.name || "").toString().trim();
      ws._name = name.length ? name.slice(0, 20) : "Người chơi";
      return send(ws, { type: "hello_ok", data: { id: ws._id, name: ws._name } });
    }

    if (type === "create_room") {
      const old = findRoomOfWs(ws);
      if (old) leaveRoom(old, ws);

      let code;
      do { code = genCode(); } while (rooms.has(code));

      const room = {
        code,
        players: [],
        spectators: [],
        board: makeEmptyBoard(),
        status: "waiting",
        winnerSymbol: 0,
        winnerId: "",
        winLine: null,
        turnIndex: 0,
        turnDeadline: 0,
        timerHandle: null,
        lastMove: null,

        // ✅ scoreboard: id -> wins
        scoreboard: new Map()
      };

      room.players.push({ id: ws._id, name: ws._name, ws, symbol: 1 });
      room.scoreboard.set(ws._id, 0);

      rooms.set(code, room);

      send(ws, { type: "room_created", data: { code } });
      broadcastRoom(room, { type: "system", data: { text: `🟢 ${ws._name} đã tạo phòng ${code}.` } });
      broadcastRoom(room, { type: "state", data: roomState(room) });
      return;
    }

    if (type === "join_room") {
      const code = (data.code || "").toString().trim().toUpperCase();
      const old = findRoomOfWs(ws);
      if (old) leaveRoom(old, ws);

      const room = rooms.get(code);
      if (!room) return send(ws, { type: "error", data: { message: "Không tìm thấy phòng." } });

      if (room.players.length < MAX_PLAYERS) {
        const used = new Set(room.players.map(p => p.symbol));
        let symbol = 1;
        while (used.has(symbol)) symbol++;
        if (symbol > 3) symbol = 3;

        room.players.push({ id: ws._id, name: ws._name, ws, symbol });

        if (!room.scoreboard.has(ws._id)) room.scoreboard.set(ws._id, 0);

        broadcastRoom(room, {
          type: "system",
          data: { text: `🟢 ${ws._name} đã vào phòng (${symbol === 1 ? "X" : symbol === 2 ? "O" : "▲"}).` }
        });

        if (room.players.length >= 2 && room.status !== "playing" && room.status !== "ended") {
          room.status = "playing";
          room.turnIndex = 0;
          startRoomTimer(room);
        }

        broadcastRoom(room, { type: "state", data: roomState(room) });
        return send(ws, { type: "join_ok", data: { code, role: "player", symbol } });
      }

      room.spectators.push({ id: ws._id, name: ws._name, ws });
      broadcastRoom(room, { type: "system", data: { text: `👀 ${ws._name} đang xem phòng.` } });
      broadcastRoom(room, { type: "state", data: roomState(room) });
      return send(ws, { type: "join_ok", data: { code, role: "spectator" } });
    }

    if (type === "leave_room") {
      const room = findRoomOfWs(ws);
      if (!room) return;
      leaveRoom(room, ws);
      return send(ws, { type: "left", data: {} });
    }

    if (type === "chat") {
      const room = findRoomOfWs(ws);
      if (!room) return send(ws, { type: "error", data: { message: "Bạn chưa vào phòng." } });

      const text = (data.text || "").toString().trim();
      if (!text.length) return;

      broadcastRoom(room, {
        type: "chat",
        data: { name: ws._name, text: text.slice(0, 400), ts: new Date().toLocaleTimeString() }
      });
      return;
    }

    if (type === "move") {
      const room = findRoomOfWs(ws);
      if (!room) return send(ws, { type: "error", data: { message: "Bạn chưa vào phòng." } });

      const info = getUserInRoom(room, ws);
      if (!info || info.role !== "player")
        return send(ws, { type: "error", data: { message: "Bạn chỉ đang xem, không được đánh." } });

      if (room.status !== "playing")
        return send(ws, { type: "error", data: { message: "Ván chưa bắt đầu hoặc đã kết thúc." } });

      if (room.players.length < 2)
        return send(ws, { type: "error", data: { message: "Chưa đủ người chơi." } });

      const current = room.players[room.turnIndex];
      if (current.ws !== ws)
        return send(ws, { type: "error", data: { message: "Chưa tới lượt bạn." } });

      const x = Number(data.x), y = Number(data.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || !inside(x, y))
        return send(ws, { type: "error", data: { message: "Nước đi không hợp lệ." } });

      if (room.board[y][x] !== 0)
        return send(ws, { type: "error", data: { message: "Ô này đã có quân." } });

      room.board[y][x] = current.symbol;

      room.lastMove = { x, y, symbol: current.symbol, name: current.name, ts: Date.now() };

      const winLine = checkWin(room.board, x, y, current.symbol);
      if (winLine) {
        room.status = "ended";
        room.winnerSymbol = current.symbol;
        room.winnerId = current.id;
        room.winLine = winLine;
        stopRoomTimer(room);

        // ✅ +1 win
        room.scoreboard.set(current.id, (room.scoreboard.get(current.id) || 0) + 1);

        broadcastRoom(room, { type: "state", data: roomState(room) });
        broadcastRoom(room, { type: "system", data: { text: `🏆 ${current.name} thắng! (+1 điểm)` } });
        return;
      }

      advanceTurn(room, false);
      return;
    }

    if (type === "restart") {
      const room = findRoomOfWs(ws);
      if (!room) return;

      const info = getUserInRoom(room, ws);
      if (!info || info.role !== "player") return;

      resetGame(room);
      broadcastRoom(room, { type: "system", data: { text: "🔁 Bắt đầu ván mới. (Người thắng ván trước được đi trước)" } });
      broadcastRoom(room, { type: "state", data: roomState(room) });
      return;
    }

    send(ws, { type: "error", data: { message: "Lệnh không hỗ trợ: " + type } });
  });

  ws.on("close", () => {
    const room = findRoomOfWs(ws);
    if (room) leaveRoom(room, ws, true);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[OK] Mở trên máy này: http://localhost:${PORT}`);
  console.log(`[LAN] Máy khác vào: http://<IP_MAY_CHU>:${PORT}`);
});
