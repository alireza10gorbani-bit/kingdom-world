const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'kingdom-world-secret-key-change-me';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- Persistent-ish storage (simple JSON file) ----------
const DB_FILE = path.join(__dirname, 'users.json');
let users = {};
function loadUsers() {
  try {
    if (fs.existsSync(DB_FILE)) users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.error('load users failed', e); users = {}; }
}
function saveUsers() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(users)); } catch (e) { console.error('save users failed', e); }
}
loadUsers();

// ---------- Map generation ----------
const TILE = { GRASS:0, WATER:1, TREE:10, STONE:11, RIVER:12, HOUSE:20, TOWER:21, WALL:22, CASTLE:23, FARM:24, CATTLE:30, SHEEP:31, CHICKEN:32 };
const MAP_W = 80, MAP_H = 80, TPX = 48;

function generateMap() {
  const map = [];
  for (let y = 0; y < MAP_H; y++) {
    const row = [];
    for (let x = 0; x < MAP_W; x++) {
      let type = TILE.GRASS;
      const r = Math.random();
      if (Math.abs(x - 40 - Math.sin(y/8)*6) < 1.5) type = TILE.RIVER;
      else if (r < 0.06) type = TILE.TREE;
      else if (r < 0.09) type = TILE.STONE;
      else if (r < 0.11) type = TILE.CATTLE;
      else if (r < 0.13) type = TILE.SHEEP;
      else if (r < 0.15) type = TILE.CHICKEN;
      row.push({ type, owner: null });
    }
    map.push(row);
  }
  return map;
}
const gameMap = generateMap();

// ---------- Game state ----------
const players = new Map();
const sockets = new Map();
let botCounter = 0;
let realPlayerEverJoined = false;

function randSpawn() {
  return { x: (5 + Math.random() * (MAP_W - 10)) * TPX, y: (5 + Math.random() * (MAP_H - 10)) * TPX };
}

function makePlayerState(username, color, saved) {
  const spawn = randSpawn();
  return {
    id: null,
    username,
    color: color || '#cc3333',
    x: spawn.x, y: spawn.y,
    hp: 100, maxHp: 100,
    level: saved?.level || 1,
    xp: saved?.xp || 0,
    kills: saved?.kills || 0,
    wood: saved?.wood || 0,
    stone: saved?.stone || 0,
    food: saved?.food || 0,
    gold: saved?.gold || 50,
    isBot: false,
    lastAttack: 0
  };
}

function broadcastPlayerList() {
  io.emit('onlineCount', players.size);
}

function publicPlayer(p) {
  return { id: p.id, username: p.username, color: p.color, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, level: p.level, xp: p.xp, kills: p.kills };
}

function addXp(p, amount) {
  p.xp += amount;
  const needed = p.level * 1000;
  if (p.xp >= needed) {
    p.level += 1;
    p.maxHp += 10;
    p.hp = p.maxHp;
    io.to(p.id).emit('notif', `🎉 لول آپ شدی! حالا لول ${p.level} هستی`);
  }
}

function persistPlayer(p) {
  if (p.isBot) return;
  users[p.username] = users[p.username] || {};
  Object.assign(users[p.username], {
    username: p.username, color: p.color, level: p.level, xp: p.xp,
    kills: p.kills, wood: p.wood, stone: p.stone, food: p.food, gold: p.gold
  });
}

// ---------- Bots ----------
const BOT_NAMES = ['اژدها','شوالیه_تنها','گرگ_خاکستری','تیرانداز','جنگجو_شب','پادشاه_سایه','شیر_بیابان','عقاب_طلایی'];
function spawnBot() {
  botCounter++;
  const name = BOT_NAMES[botCounter % BOT_NAMES.length] + '_' + botCounter;
  const colors = ['#cc3333','#3366cc','#33aa44','#cc8800','#9933cc','#cc6633'];
  const p = makePlayerState(name, colors[botCounter % colors.length], null);
  p.id = 'bot_' + botCounter;
  p.isBot = true;
  players.set(p.id, p);
  io.emit('playerJoined', publicPlayer(p));
  broadcastPlayerList();
}

function botTick() {
  for (const [id, p] of players) {
    if (!p.isBot) continue;
    if (Math.random() < 0.3) {
      const dx = (Math.random() - 0.5) * 120;
      const dy = (Math.random() - 0.5) * 120;
      p.x = Math.max(0, Math.min(MAP_W * TPX, p.x + dx));
      p.y = Math.max(0, Math.min(MAP_H * TPX, p.y + dy));
      io.emit('playerMoved', { id, x: p.x, y: p.y });
    }
    if (Math.random() < 0.5) {
      p.wood += 1; p.stone += 1; p.food += 1;
    }
  }
}
setInterval(botTick, 4000);

setTimeout(() => {
  if (!realPlayerEverJoined) {
    for (let i = 0; i < 5; i++) spawnBot();
    io.emit('systemMsg', '🤖 چندتا بازیکن به دنیا اضافه شدن!');
  }
}, 60 * 1000);

// ---------- Auth API ----------
app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.json({ ok: false, msg: 'همه فیلدها لازمه' });
  if (users[username]) return res.json({ ok: false, msg: 'این نام کاربری قبلاً ثبت شده' });
  const passHash = bcrypt.hashSync(password, 8);
  users[username] = { username, passHash, color: '#cc3333', level: 1, xp: 0, kills: 0, wood: 0, stone: 0, food: 0, gold: 50 };
  saveUsers();
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, username, level: 1 });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username, admin: true }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ ok: true, isAdmin: true, token, username });
  }
  const u = users[username];
  if (!u || !bcrypt.compareSync(password, u.passHash || '')) {
    return res.json({ ok: false, msg: 'نام کاربری یا رمز اشتباهه' });
  }
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ ok: true, token, username, level: u.level || 1 });
});

app.get('/api/leaderboard', (req, res) => {
  const list = Object.values(users)
    .map(u => ({ username: u.username, level: u.level || 1, kills: u.kills || 0 }))
    .sort((a, b) => b.level - a.level || b.kills - a.kills)
    .slice(0, 50);
  res.json(list);
});

function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  try {
    const data = jwt.verify(token, JWT_SECRET);
    if (!data.admin) return res.status(403).json({ ok: false });
    next();
  } catch { res.status(401).json({ ok: false }); }
}
app.get('/api/admin/players', requireAdmin, (req, res) => {
  res.json(Array.from(players.values()).map(publicPlayer));
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(Object.values(users).map(u => ({ username: u.username, level: u.level, kills: u.kills })));
});

// ---------- Socket.io game logic ----------
io.on('connection', (socket) => {
  sockets.set(socket.id, socket);

  socket.on('join', ({ token, color }) => {
    let username;
    try {
      const data = jwt.verify(token, JWT_SECRET);
      username = data.username;
    } catch {
      socket.emit('kicked', 'توکن نامعتبره، دوباره وارد شو');
      return;
    }
    realPlayerEverJoined = true;
    const saved = users[username];
    const p = makePlayerState(username, color || saved?.color, saved);
    p.id = socket.id;
    players.set(socket.id, p);

    socket.emit('init', {
      map: gameMap,
      myId: socket.id,
      players: Array.from(players.values()).map(publicPlayer)
    });
    socket.broadcast.emit('playerJoined', publicPlayer(p));
    io.emit('systemMsg', `👑 ${username} وارد سرزمین شد`);
    broadcastPlayerList();
  });

  socket.on('move', ({ x, y }) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.x = Math.max(0, Math.min(MAP_W * TPX, x));
    p.y = Math.max(0, Math.min(MAP_H * TPX, y));
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y });
  });

  socket.on('chop', ({ tx, ty }) => {
    const p = players.get(socket.id);
    if (!p || !inBounds(tx, ty)) return;
    const tile = gameMap[ty][tx];
    if (tile.type !== TILE.TREE) return;
    if (!nearTile(p, tx, ty)) return;
    tile.type = TILE.GRASS;
    p.wood += 5;
    addXp(p, 10);
    io.emit('tileChanged', { tx, ty, tile });
    socket.emit('resources', resourcesOf(p));
    setTimeout(() => {
      if (gameMap[ty][tx].type === TILE.GRASS && Math.random() < 0.3) {
        gameMap[ty][tx].type = TILE.TREE;
        io.emit('tileChanged', { tx, ty, tile: gameMap[ty][tx] });
      }
    }, 30000);
  });

  socket.on('mine', ({ tx, ty }) => {
    const p = players.get(socket.id);
    if (!p || !inBounds(tx, ty)) return;
    const tile = gameMap[ty][tx];
    if (tile.type !== TILE.STONE) return;
    if (!nearTile(p, tx, ty)) return;
    tile.type = TILE.GRASS;
    p.stone += 5;
    addXp(p, 10);
    io.emit('tileChanged', { tx, ty, tile });
    socket.emit('resources', resourcesOf(p));
    setTimeout(() => {
      if (gameMap[ty][tx].type === TILE.GRASS && Math.random() < 0.3) {
        gameMap[ty][tx].type = TILE.STONE;
        io.emit('tileChanged', { tx, ty, tile: gameMap[ty][tx] });
      }
    }, 30000);
  });

  socket.on('harvest', ({ tx, ty }) => {
    const p = players.get(socket.id);
    if (!p || !inBounds(tx, ty)) return;
    const tile = gameMap[ty][tx];
    if (![TILE.CATTLE, TILE.SHEEP, TILE.CHICKEN, TILE.RIVER].includes(tile.type)) return;
    if (!nearTile(p, tx, ty)) return;
    p.food += 8;
    addXp(p, 8);
    socket.emit('resources', resourcesOf(p));
  });

  socket.on('build', ({ tx, ty, type }) => {
    const p = players.get(socket.id);
    if (!p || !inBounds(tx, ty)) return;
    const tile = gameMap[ty][tx];
    if (tile.type !== TILE.GRASS) { socket.emit('notif', '❌ اینجا نمی‌تونی بسازی'); return; }
    const costs = {
      [TILE.HOUSE]:  { wood:15, stone:5 },
      [TILE.TOWER]:  { wood:10, stone:20 },
      [TILE.WALL]:   { wood:0,  stone:8 },
      [TILE.CASTLE]: { wood:50, stone:80 },
      [TILE.FARM]:   { wood:20, stone:0 },
    };
    const cost = costs[type];
    if (!cost) return;
    if (p.wood < cost.wood || p.stone < cost.stone) { socket.emit('notif', '❌ منابع کافی نیست'); return; }
    p.wood -= cost.wood; p.stone -= cost.stone;
    tile.type = type; tile.owner = p.username;
    addXp(p, 25);
    io.emit('tileChanged', { tx, ty, tile });
    socket.emit('resources', resourcesOf(p));
    socket.emit('notif', '🏗️ ساخته شد!');
  });

  socket.on('recruit', ({ role, weapon }) => {
    const p = players.get(socket.id);
    if (!p) return;
    const costs = {
      sword:  { gold:40, food:20 },
      bow:    { gold:40, food:20 },
      cannon: { gold:60, food:30 },
      none:   { gold:20, food:10 },
    };
    const cost = costs[weapon] || costs.none;
    if (p.gold < cost.gold || p.food < cost.food) { socket.emit('notif', '❌ منابع کافی نیست'); return; }
    p.gold -= cost.gold; p.food -= cost.food;
    p.maxHp += role === 'soldier' ? 15 : 5;
    p.hp = p.maxHp;
    addXp(p, 15);
    socket.emit('resources', resourcesOf(p));
    socket.emit('notif', `✅ ${role === 'soldier' ? 'سرباز' : 'شهروند'} استخدام شد!`);
  });

  socket.on('attack', ({ targetId }) => {
    const p = players.get(socket.id);
    const t = players.get(targetId);
    if (!p || !t) return;
    const dx = t.x - p.x, dy = t.y - p.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > 220) { socket.emit('notif', '❌ خیلی دوره'); return; }
    const now = Date.now();
    if (now - p.lastAttack < 800) return;
    p.lastAttack = now;
    const dmg = 8 + Math.floor(Math.random() * 10) + Math.floor(p.level * 1.5);
    t.hp -= dmg;
    if (t.id && sockets.has(t.id)) {
      sockets.get(t.id).emit('damaged', { from: p.username, dmg });
    }
    io.emit('playerUpdated', { id: t.id, kills: t.kills, xp: t.xp, level: t.level, hp: t.hp });
    if (t.hp <= 0) {
      p.kills += 1;
      addXp(p, 50);
      io.emit('kill', { killer: p.username, victim: t.username });
      const spawn = randSpawn();
      t.hp = t.maxHp; t.x = spawn.x; t.y = spawn.y;
      if (t.id && sockets.has(t.id)) {
        sockets.get(t.id).emit('respawn', { x: t.x, y: t.y });
      }
      persistPlayer(p); saveUsers();
    }
    io.emit('playerUpdated', { id: p.id, kills: p.kills, xp: p.xp, level: p.level, hp: p.hp });
  });

  socket.on('chat', (msg) => {
    const p = players.get(socket.id);
    if (!p || !msg) return;
    const clean = String(msg).slice(0, 80);
    io.emit('chat', { username: p.username, msg: clean });
  });

  socket.on('report', ({ reported, reason }) => {
    const p = players.get(socket.id);
    if (!p) return;
    console.log(`[REPORT] ${p.username} reported ${reported}: ${reason}`);
    socket.emit('notif', '✅ گزارش به ادمین ارسال شد');
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      persistPlayer(p);
      saveUsers();
      players.delete(socket.id);
      io.emit('playerLeft', socket.id);
      io.emit('systemMsg', `👋 ${p.username} خروج کرد`);
      broadcastPlayerList();
    }
    sockets.delete(socket.id);
  });
});

function inBounds(tx, ty) { return tx >= 0 && tx < MAP_W && ty >= 0 && ty < MAP_H; }
function nearTile(p, tx, ty) {
  const px = p.x / TPX, py = p.y / TPX;
  return Math.abs(px - tx) < 3 && Math.abs(py - ty) < 3;
}
function resourcesOf(p) { return { wood: p.wood, stone: p.stone, food: p.food, gold: p.gold }; }

setInterval(() => {
  for (const [id, p] of players) {
    if (p.isBot) continue;
    p.gold += 3 + p.level;
    p.food += 1;
    if (sockets.has(id)) {
      sockets.get(id).emit('resources', resourcesOf(p));
    }
  }
}, 10000);

setInterval(() => {
  for (const [, p] of players) persistPlayer(p);
  saveUsers();
}, 30000);

server.listen(PORT, () => console.log(`🏰 Kingdom World server running on port ${PORT}`));
