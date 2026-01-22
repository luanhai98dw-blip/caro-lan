const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = 15000;
const BOARD_SIZE = 15;
const WIN_COUNT = 5;

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ====== dữ liệu phòng ======
/**
 * rooms[code] = {
 *   code,
 *   players: [{ id, name, ws, symbol: 1|2 }], // 1: X, 2: O
 *   spectators: [{ id, name, ws }],
 *   board: number[][],
 *   turn: 1|2,
 *   status: "waiting"|"playing"|"ended",
 *   winner: 0|1|2,
 *   winLine: [{x,y}] | null,
 * }
 */
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
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj) {
  room.players.forEach(p => send(p.ws, obj));
  room.spectators.forEach(s => send(s.ws, obj));
}

function roomState(room) {
  return {
    code: room.code,
    status: room.status,
    turn: room.turn,
    winner: room.winner,
    winLine: room.winLine,
    players: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })),
    spectators: room.spectators.map(s => ({ id: s.id, name: s.name })),
    board: room.board
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
  let p = room.players.find(x => x.ws === ws);
  if (p) return { role: "player", user: p };
  let s = room.spectators.find(x => x.ws === ws);
  if (s) return { role: "spectator", user: s };
  return null;
}

// ====== check win ======
function inside(x, y) {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function checkWin(board, x, y, symbol) {
  // 4 hướng: ngang, dọc, chéo xuống, chéo lên
  const dirs = [
    { dx: 1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 1 },
    { dx: 1, dy: -1 }
  ];

  for (const d of dirs) {
    const line = [{ x, y }];

    // đi 1 chiều
    let nx = x + d.dx, ny = y + d.dy;
    while (inside(nx, ny) && board[ny][nx] === symbol) {
      line.push({ x: nx, y: ny });
      nx += d.dx; ny += d.dy;
    }

    // đi chiều ngược
    nx = x - d.dx; ny = y - d.dy;
    while (inside(nx, ny) && board[ny][nx] === symbol) {
      line.unshift({ x: nx, y: ny });
      nx -= d.dx; ny -= d.dy;
    }

    if (line.length >= WIN_COUNT) {
      // lấy đúng 5 ô (cho đẹp)
      // chọn đoạn 5 chứa (x,y) gần giữa
      // đơn giản: lấy 5 ô đầu
      return line.slice(0, WIN_COUNT);
    }
  }
  return null;
}

function resetGame(room) {
  room.board = makeEmptyBoard();
  room.turn = 1;
  room.status = room.players.length === 2 ? "playing" : "waiting";
  room.winner = 0;
  room.winLine = null;
}

// ====== WS events ======
wss.on("connection", (ws) => {
  ws._id = "U" + Math.random().toString(16).slice(2, 8).toUpperCase();
  ws._name = "Người chơi";

  send(ws, { type: "welcome", data: { note: "Chào mừng bạn đến CARO LAN!" } });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); }
    catch {
      return send(ws, { type: "error", data: { message: "Dữ liệu JSON không hợp lệ." } });
    }

    const type = msg.type;
    const data = msg.data || {};

    // set tên
    if (type === "hello") {
      const name = (data.name || "").toString().trim();
      ws._name = name.length ? name.slice(0, 20) : "Người chơi";
      return send(ws, { type: "hello_ok", data: { id: ws._id, name: ws._name } });
    }

    if (type === "create_room") {
      // rời phòng cũ nếu có
      const old = findRoomOfWs(ws);
      if (old) leaveRoom(old, ws);

      let code;
      do { code = genCode(); } while (rooms.has(code));

      const room = {
        code,
        players: [],
        spectators: [],
        board: makeEmptyBoard(),
        turn: 1,
        status: "waiting",
        winner: 0,
        winLine: null
      };

      // vào làm player X
      room.players.push({ id: ws._id, name: ws._name, ws, symbol: 1 });
      rooms.set(code, room);

      send(ws, { type: "room_created", data: { code } });
      broadcastRoom(room, { type: "state", data: roomState(room) });
      broadcastRoom(room, { type: "system", data: { text: `🟢 ${ws._name} đã tạo phòng ${code}.` } });
      return;
    }

    if (type === "join_room") {
      const code = (data.code || "").toString().trim().toUpperCase();

      // rời phòng cũ nếu có
      const old = findRoomOfWs(ws);
      if (old) leaveRoom(old, ws);

      const room = rooms.get(code);
      if (!room) return send(ws, { type: "error", data: { message: "Không tìm thấy phòng." } });

      // nếu đã đủ 2 player → vào spectator
      if (room.players.length < 2) {
        const symbol = room.players.some(p => p.symbol === 1) ? 2 : 1;
        room.players.push({ id: ws._id, name: ws._name, ws, symbol });

        // đủ 2 thì bắt đầu
        if (room.players.length === 2) {
          room.status = "playing";
          room.turn = 1;
        }

        broadcastRoom(room, { type: "system", data: { text: `🟢 ${ws._name} đã vào phòng (${symbol === 1 ? "X" : "O"}).` } });
        broadcastRoom(room, { type: "state", data: roomState(room) });
        return send(ws, { type: "join_ok", data: { code, role: "player", symbol } });
      } else {
        room.spectators.push({ id: ws._id, name: ws._name, ws });
        broadcastRoom(room, { type: "system", data: { text: `👀 ${ws._name} đang xem phòng.` } });
        broadcastRoom(room, { type: "state", data: roomState(room) });
        return send(ws, { type: "join_ok", data: { code, role: "spectator" } });
      }
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
      if (!info || info.role !== "player") return send(ws, { type: "error", data: { message: "Bạn chỉ đang xem, không được đánh." } });

      if (room.status !== "playing") return send(ws, { type: "error", data: { message: "Ván chưa bắt đầu hoặc đã kết thúc." } });

      const player = info.user;
      if (player.symbol !== room.turn) return send(ws, { type: "error", data: { message: "Chưa tới lượt bạn." } });

      const x = Number(data.x), y = Number(data.y);
      if (!Number.isInteger(x) || !Number.isInteger(y) || !inside(x, y))
        return send(ws, { type: "error", data: { message: "Nước đi không hợp lệ." } });

      if (room.board[y][x] !== 0) return send(ws, { type: "error", data: { message: "Ô này đã có quân." } });

      room.board[y][x] = player.symbol;

      const winLine = checkWin(room.board, x, y, player.symbol);
      if (winLine) {
        room.status = "ended";
        room.winner = player.symbol;
        room.winLine = winLine;

        broadcastRoom(room, { type: "state", data: roomState(room) });
        broadcastRoom(room, { type: "system", data: { text: `🏆 ${player.name} thắng!` } });
        return;
      }

      // đổi lượt
      room.turn = room.turn === 1 ? 2 : 1;

      broadcastRoom(room, { type: "state", data: roomState(room) });
      return;
    }

    if (type === "restart") {
      const room = findRoomOfWs(ws);
      if (!room) return;

      // chỉ cho player restart (đơn giản)
      const info = getUserInRoom(room, ws);
      if (!info || info.role !== "player") return;

      resetGame(room);
      broadcastRoom(room, { type: "system", data: { text: "🔁 Bắt đầu ván mới." } });
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

function leaveRoom(room, ws, isDisconnect = false) {
  // remove player
  const pi = room.players.findIndex(p => p.ws === ws);
  if (pi >= 0) {
    const p = room.players[pi];
    room.players.splice(pi, 1);

    broadcastRoom(room, { type: "system", data: { text: `🔴 ${p.name} đã rời phòng${isDisconnect ? " (mất kết nối)" : ""}.` } });

    // nếu đang chơi mà 1 người rời → end
    if (room.status === "playing") {
      room.status = "ended";
      room.winner = 0;
      room.winLine = null;
      broadcastRoom(room, { type: "system", data: { text: "⚠️ Ván kết thúc do có người thoát." } });
    }
  }

  // remove spectator
  const si = room.spectators.findIndex(s => s.ws === ws);
  if (si >= 0) {
    const s = room.spectators[si];
    room.spectators.splice(si, 1);
    broadcastRoom(room, { type: "system", data: { text: `👋 ${s.name} ngừng xem.` } });
  }

  // nếu không còn ai → xóa phòng
  if (room.players.length === 0 && room.spectators.length === 0) {
    rooms.delete(room.code);
    return;
  }

  // cập nhật trạng thái room
  if (room.players.length < 2) room.status = "waiting";

  broadcastRoom(room, { type: "state", data: roomState(room) });
}

server.listen(PORT, () => {
  console.log(`[HTTP] Mở trình duyệt: http://localhost:${PORT}`);
  console.log(`[LAN ] Máy khác vào: http://<IP_MAY_CHAY_SERVER>:${PORT}`);
});
