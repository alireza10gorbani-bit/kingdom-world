const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const JWT_SECRET = process.env.JWT_SECRET || 'kingdom-secret-2024';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin1234';
const PORT = process.env.PORT || 3000;

const db = new Database('kingdom.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    banned INTEGER DEFAULT 0,
    ban_reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter TEXT NOT NULL,
    reported TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, msg: 'نام کاربری و رمز لازمه' });
  if (username.length < 3) return res.json({ ok: false, msg: 'نام کاربری حداقل ۳ حرف' });
  if (username === ADMIN_USER) return res.json({ ok: false, msg: 'این نام رزرو شده' });
  try {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hash);
    const token = jwt.sign({ username, isAdmin: false }, JWT_SECRET);
    res.json({ ok: true, token, username, level: 1, xp: 0 });
  } catch (e) {
    res.json({ ok: false, msg: 'این نام قبلاً ثبت شده' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = jwt.sign({ username, isAdmin: true }, JWT_SECRET);
    return res.json({ ok: true, token, username, isAdmin: true, level: 99 });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return res.json({ ok: false, msg: 'کاربر یافت نشد' });
  if (user.banned) return res.json({ ok: false, msg: `بن شدی: ${user.ban_reason}` });
  const bcrypt = require('bcryptjs');
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.json({ ok: false, msg: 'رمز اشتباهه' });
  const token = jwt.sign({ username, isAdmin: false }, JWT_SECRET);
  res.json({ ok: true, token, username, level: user.level, xp: user.xp, kills: user.kills });
});

app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare('SELECT username, level, xp, kills FROM users WHERE banned=0 ORDER BY level DESC, xp DESC LIMIT 50').all();
  res.json(rows);
});

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.json({ ok: false, msg: 'دسترسی نداری' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (!d.isAdmin) return res.json({ ok: false, msg: 'فقط ادمین' });
    next();
  } catch { res.json({ ok: false, msg: 'توکن نامعتبر' }); }
}

app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = db.prepare('SELECT id,username,level,xp,kills,deaths,banned,ban_reason,created_at FROM users ORDER BY id DESC').all();
  res.json({ ok: true, users });
});

app.post('/api/admin/ban', adminAuth, (req, res) => {
  const { username, reason } = req.body;
  db.prepare('UPDATE users SET banned=1, ban_reason=? WHERE username=?').run(reason || 'تخلف', username);
  const sock = onlinePlayers.get(username);
  if (sock) io.to(sock).emit('kicked', 'بن شدی: ' + reason);
  res.json({ ok: true });
});

app.post('/api/admin/unban', adminAuth, (req, res) => {
  db.prepare('UPDATE users SET banned=0, ban_reason="" WHERE username=?').run(req.body.username);
  res.json({ ok: true });
});

app.get('/api/admin/reports', adminAuth, (req, res) => {
  res.json({ ok: true, reports: db.prepare('SELECT * FROM reports ORDER BY id DESC').all() });
});

app.post('/api/admin/report-status', adminAuth, (req, res) => {
  db.prepare('UPDATE reports SET status=? WHERE id=?').run(req.body.status, req.body.id);
  res.json({ ok: true });
});

app.get('/api/admin/stats', adminAuth, (req, res) => {
  res.json({
    ok: true,
    total: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    banned: db.prepare('SELECT COUNT(*) as c FROM users WHERE banned=1').get().c,
    online: gameState.players.size,
    pendingReports: db.prepare('SELECT COUNT(*) as c FROM reports WHERE status="pending"').get().c,
  });
});

app.post('/api/admin/broadcast', adminAuth, (req, res) => {
  io.emit('systemMsg', req.body.msg);
  res.json({ ok: true });
});

const MAP_W = 80, MAP_H = 80, TILE = 48;
const T = { GRASS:0, WATER:1, TREE:10, STONE:11, RIVER:12, HOUSE:20, TOWER:21, WALL:22, CASTLE:23, FARM:24, CATTLE:30, SHEEP:31, CHICKEN:32 };

function generateMap() {
  const map = [];
  for (let y = 0; y < MAP_H; y++) {
    map[y] = [];
    for (let x = 0; x < MAP_W; x++) {
      const n = Math.sin(x*0.3)*Math.cos(y*0.3)*0.5+0.5;
      map[y][x] = { type: n < 0.2 ? T.WATER : T.GRASS, owner: null, hp: 0 };
    }
  }
  for (let i = 0; i < 280; i++) {
    const x=Math.floor(Math.random()*MAP_W), y=Math.floor(Math.random()*MAP_H);
    if (map[y][x].type===T.GRASS) map[y][x]={ type:T.TREE, owner:null, hp:5 };
  }
  for (let i = 0; i < 140; i++) {
    const x=Math.floor(Math.random()*MAP_W), y=Math.floor(Math.random()*MAP_H);
    if (map[y][x].type===T.GRASS) map[y][x]={ type:T.STONE, owner:null, hp:8 };
  }
  for (let i = 0; i < 3; i++) {
    const ry=10+Math.floor(Math.random()*60);
    for (let x=0; x<MAP_W; x++) if (map[ry][x].type===T.GRASS) map[ry][x]={ type:T.RIVER, owner:null, hp:0 };
  }
  for (let i = 0; i < 50; i++) {
    const x=Math.floor(Math.random()*MAP_W), y=Math.floor(Math.random()*MAP_H);
    if (map[y][x].type===T.GRASS) map[y][x]={ type:[T.CATTLE,T.SHEEP,T.CHICKEN][Math.floor(Math.random()*3)], owner:null, hp:3 };
  }
  return map;
}

const gameState = { map: generateMap(), players: new Map() };
const onlinePlayers = new Map();

io.on('connection', (socket) => {
  let currentUser = null;

  socket.on('join', (data) => {
    try {
      const decoded = jwt.verify(data.token, JWT_SECRET);
      currentUser = decoded.username;
      if (decoded.isAdmin) return;
      const user = db.prepare('SELECT * FROM users WHERE username=?').get(currentUser);
      if (!user || user.banned) { socket.emit('kicked', 'بن شدی'); return; }
      onlinePlayers.set(currentUser, socket.id);
      const p = {
        id: socket.id, username: currentUser,
        x: 200+Math.random()*(MAP_W*TILE-400), y: 200+Math.random()*(MAP_H*TILE-400),
        hp: 100, maxHp: 100, level: user.level, xp: user.xp, kills: user.kills,
        wood: 50, stone: 30, food: 50, gold: 100,
        color: data.color || '#cc3333', territory: [], units: [],
      };
      gameState.players.set(socket.id, p);
      socket.emit('init', { map: gameState.map, players: Array.from(gameState.players.values()), myId: socket.id });
      socket.broadcast.emit('playerJoined', p);
      io.emit('systemMsg', `⚔️ ${currentUser} وارد دنیا شد`);
    } catch { socket.emit('kicked', 'خطا'); }
  });

  socket.on('move', (d) => {
    const p = gameState.players.get(socket.id); if (!p) return;
    p.x = Math.max(0, Math.min(MAP_W*TILE, d.x));
    p.y = Math.max(0, Math.min(MAP_H*TILE, d.y));
    socket.broadcast.emit('playerMoved', { id: socket.id, x: p.x, y: p.y });
  });

  socket.on('attack', (d) => {
    const a = gameState.players.get(socket.id), t = gameState.players.get(d.targetId);
    if (!a || !t) return;
    const dx=t.x-a.x, dy=t.y-a.y;
    if (Math.sqrt(dx*dx+dy*dy) > 120) return;
    const dmg = 10 + a.level * 2;
    t.hp -= dmg;
    io.to(d.targetId).emit('damaged', { from: a.username, dmg });
    if (t.hp <= 0) {
      t.hp = t.maxHp;
      t.x = 200+Math.random()*(MAP_W*TILE-400);
      t.y = 200+Math.random()*(MAP_H*TILE-400);
      a.kills++; a.xp += 50 + t.level*10;
      if (a.xp >= a.level*1000) { a.level++; a.xp=0; }
      db.prepare('UPDATE users SET kills=?,xp=?,level=? WHERE username=?').run(a.kills,a.xp,a.level,a.username);
      db.prepare('UPDATE users SET deaths=deaths+1 WHERE username=?').run(t.username);
      io.emit('kill', { killer: a.username, victim: t.username });
      io.to(d.targetId).emit('respawn', { x: t.x, y: t.y });
      io.emit('playerUpdated', { id: socket.id, kills: a.kills, xp: a.xp, level: a.level });
    }
  });

  socket.on('chop', (d) => {
    const p=gameState.players.get(socket.id); if (!p) return;
    const tile=gameState.map[d.ty]?.[d.tx]; if (!tile||tile.type!==T.TREE) return;
    tile.hp--;
    if (tile.hp<=0) {
      gameState.map[d.ty][d.tx]={ type:T.GRASS, owner:null, hp:0 };
      p.wood+=8;
      socket.emit('resources',{wood:p.wood,stone:p.stone,food:p.food,gold:p.gold});
      io.emit('tileChanged',{tx:d.tx,ty:d.ty,tile:gameState.map[d.ty][d.tx]});
      socket.emit('notif','+8 🪵 چوب!');
    }
  });

  socket.on('mine', (d) => {
    const p=gameState.players.get(socket.id); if (!p) return;
    const tile=gameState.map[d.ty]?.[d.tx]; if (!tile||tile.type!==T.STONE) return;
    tile.hp--;
    if (tile.hp<=0) {
      gameState.map[d.ty][d.tx]={ type:T.GRASS, owner:null, hp:0 };
      p.stone+=6;
      socket.emit('resources',{wood:p.wood,stone:p.stone,food:p.food,gold:p.gold});
      io.emit('tileChanged',{tx:d.tx,ty:d.ty,tile:gameState.map[d.ty][d.tx]});
      socket.emit('notif','+6 🪨 سنگ!');
    }
  });

  socket.on('harvest', (d) => {
    const p=gameState.players.get(socket.id); if (!p) return;
    const tile=gameState.map[d.ty]?.[d.tx]; if (!tile) return;
    if (tile.type===T.RIVER) { p.food+=5; socket.emit('notif','+5 💧 آب!'); }
    else if ([T.CATTLE,T.SHEEP,T.CHICKEN].includes(tile.type)) {
      p.food+=tile.type===T.CATTLE?15:tile.type===T.SHEEP?10:5;
      gameState.map[d.ty][d.tx]={ type:T.GRASS, owner:null, hp:0 };
      io.emit('tileChanged',{tx:d.tx,ty:d.ty,tile:gameState.map[d.ty][d.tx]});
      socket.emit('notif','🍖 غذا گرفتی!');
    }
    socket.emit('resources',{wood:p.wood,stone:p.stone,food:p.food,gold:p.gold});
  });

  socket.on('build', (d) => {
    const p=gameState.players.get(socket.id); if (!p) return;
    const tile=gameState.map[d.ty]?.[d.tx]; if (!tile||tile.type!==T.GRASS) { socket.emit('notif','❌ اینجا نمیشه'); return; }
    const costs={20:{wood:15,stone:5},21:{wood:10,stone:20},22:{stone:8},23:{wood:50,stone:80},24:{wood:20}};
    const cost=costs[d.type]; if (!cost) return;
    for (const [r,a] of Object.entries(cost)) if (p[r]<a) { socket.emit('notif','❌ منابع کافی نیست'); return; }
    for (const [r,a] of Object.entries(cost)) p[r]-=a;
    gameState.map[d.ty][d.tx]={ type:d.type, owner:socket.id, hp:30 };
    p.territory.push(`${d.tx},${d.ty}`);
    socket.emit('resources',{wood:p.wood,stone:p.stone,food:p.food,gold:p.gold});
    io.emit('tileChanged',{tx:d.tx,ty:d.ty,tile:gameState.map[d.ty][d.tx]});
    socket.emit('notif','✅ ساخته شد!');
  });

  socket.on('recruit', (d) => {
    const p=gameState.players.get(socket.id); if (!p) return;
    if (p.gold<40||p.food<20) { socket.emit('notif','❌ منابع کافی نیست'); return; }
    p.gold-=40; p.food-=20;
    socket.emit('resources',{wood:p.wood,stone:p.stone,food:p.food,gold:p.gold});
    socket.emit('notif','⚔️ سرباز استخدام شد!');
  });

  socket.on('chat', (msg) => {
    if (currentUser) io.emit('chat',{ username:currentUser, msg:String(msg).slice(0,100) });
  });

  socket.on('report', (d) => {
    if (currentUser) {
      db.prepare('INSERT INTO reports (reporter,reported,reason) VALUES (?,?,?)').run(currentUser,d.reported,d.reason);
      socket.emit('notif','✅ گزارش ثبت شد');
    }
  });

  socket.on('disconnect', () => {
    if (currentUser) { onlinePlayers.delete(currentUser); io.emit('systemMsg',`👋 ${currentUser} رفت`); }
    const p=gameState.players.get(socket.id);
    if (p) db.prepare('UPDATE users SET xp=?,level=?,kills=? WHERE username=?').run(p.xp,p.level,p.kills,p.username);
    gameState.players.delete(socket.id);
    io.emit('playerLeft', socket.id);
  });
});

setInterval(() => {
  for (const [id,p] of gameState.players) {
    p.gold+=3+p.level; p.food+=1;
    io.to(id).emit('resources',{wood:p.wood,stone:p.stone,food:p.food,gold:p.gold});
  }
}, 10000);

server.listen(PORT, () => console.log(`🏰 Kingdom World on port ${PORT}`));
