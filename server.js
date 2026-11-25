const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'questions.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/play', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    const lower = name.toLowerCase();
    // Skip virtual adapters (WSL, Hyper-V, Docker, VirtualBox) when possible
    const isVirtual =
      lower.includes('wsl') ||
      lower.includes('vethernet') ||
      lower.includes('docker') ||
      lower.includes('virtual') ||
      lower.includes('vmware');
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push({ address: net.address, isVirtual, name });
      }
    }
  }
  const preferred =
    candidates.find((c) => !c.isVirtual && (c.address.startsWith('192.168.') || c.address.startsWith('10.'))) ||
    candidates.find((c) => !c.isVirtual) ||
    candidates[0];
  return preferred ? preferred.address : 'localhost';
}

function loadQuiz() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { title: 'Live Quiz', subtitle: 'Scan QR to join!', questions: [] };
  }
}

function saveQuiz(quizData) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(quizData, null, 2), 'utf8');
}

function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// --- Live Game State ---
let quiz = loadQuiz();
const state = {
  pin: generatePin(),
  phase: 'lobby', // 'lobby' | 'question' | 'reveal' | 'leaderboard' | 'finished'
  currentIndex: 0,
  questionStartTime: null,
  timeLeft: 0,
  timerInterval: null,
  players: new Map(), // playerId -> { id, name, avatar, score, streak, lastPoints, lastCorrect, answeredCurrent, currentChoice, socketId }
};

function clearTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function getRankedPlayers() {
  return Array.from(state.players.values())
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .map((p, idx) => ({
      rank: idx + 1,
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      lastPoints: p.lastPoints,
      lastCorrect: p.lastCorrect,
      answeredCurrent: p.answeredCurrent,
    }));
}

function getVoteCounts() {
  const q = quiz.questions[state.currentIndex];
  const count = q ? q.options.length : 4;
  const counts = new Array(count).fill(0);
  for (const p of state.players.values()) {
    if (p.answeredCurrent && typeof p.currentChoice === 'number' && p.currentChoice >= 0 && p.currentChoice < count) {
      counts[p.currentChoice]++;
    }
  }
  return counts;
}

function buildPublicState(includeCorrect = false) {
  const q = quiz.questions[state.currentIndex] || null;
  const totalPlayers = state.players.size;
  const answeredCount = Array.from(state.players.values()).filter((p) => p.answeredCurrent).length;
  const ranked = getRankedPlayers();

  return {
    pin: state.pin,
    phase: state.phase,
    title: quiz.title,
    subtitle: quiz.subtitle,
    currentIndex: state.currentIndex,
    totalQuestions: quiz.questions.length,
    timeLeft: state.timeLeft,
    totalTime: q ? q.timeLimit || 30 : 30,
    totalPlayers,
    answeredCount,
    question: q
      ? {
          id: q.id,
          text: q.text,
          image: q.image,
          options: q.options,
          timeLimit: q.timeLimit || 30,
          points: q.points || 1,
          ...(includeCorrect || state.phase === 'reveal' || state.phase === 'leaderboard' || state.phase === 'finished'
            ? { correctIndex: q.correctIndex }
            : {}),
        }
      : null,
    votes: state.phase === 'reveal' || includeCorrect ? getVoteCounts() : null,
    leaderboard: ranked,
  };
}

function broadcastState() {
  io.to('host').emit('state:update', buildPublicState(true));
  io.to('players').emit('state:update', buildPublicState(false));
}

function startQuestion(index) {
  clearTimer();
  if (index >= quiz.questions.length) {
    state.phase = 'finished';
    broadcastState();
    return;
  }

  state.currentIndex = index;
  state.phase = 'question';
  const q = quiz.questions[index];
  const duration = Number(q.timeLimit) || 30;
  state.timeLeft = duration;
  state.questionStartTime = Date.now();

  for (const p of state.players.values()) {
    p.answeredCurrent = false;
    p.currentChoice = null;
    p.lastPoints = 0;
    p.lastCorrect = null;
  }

  broadcastState();

  state.timerInterval = setInterval(() => {
    state.timeLeft = Math.max(0, state.timeLeft - 1);
    io.emit('timer:tick', { timeLeft: state.timeLeft, totalTime: duration });
    if (state.timeLeft <= 0) {
      revealAnswer();
    }
  }, 1000);
}

function revealAnswer() {
  clearTimer();
  if (state.phase !== 'question') return;
  state.phase = 'reveal';
  broadcastState();
}

// --- REST API ---
app.get('/api/info', (req, res) => {
  const lanIp = getLocalLanIp();
  res.json({
    lanIp,
    port: PORT,
    pin: state.pin,
    defaultJoinUrl: `http://${lanIp}:${PORT}/play?pin=${state.pin}`,
  });
});

app.get('/api/qr', async (req, res) => {
  try {
    const targetUrl = req.query.url || `http://${getLocalLanIp()}:${PORT}/play?pin=${state.pin}`;
    const dataUrl = await QRCode.toDataURL(String(targetUrl), {
      width: 420,
      margin: 2,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
    res.json({ dataUrl, url: targetUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

app.get('/api/quiz', (req, res) => {
  res.json(quiz);
});

app.put('/api/quiz', (req, res) => {
  const { title, subtitle, questions } = req.body || {};
  if (!Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Quiz must have at least one question.' });
  }
  quiz = {
    title: typeof title === 'string' && title.trim() ? title.trim() : quiz.title,
    subtitle: typeof subtitle === 'string' ? subtitle.trim() : quiz.subtitle,
    questions: questions.map((q, idx) => ({
      id: q.id || `q${idx + 1}_${Date.now()}`,
      text: String(q.text || '').trim() || `Question ${idx + 1}`,
      image: q.image || null,
      options: Array.isArray(q.options) && q.options.length >= 2 ? q.options.map((o) => String(o)) : ['Option A', 'Option B', 'Option C', 'Option D'],
      correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
      timeLimit: Math.max(5, Math.min(180, Number(q.timeLimit) || 30)),
      points: Math.max(1, Math.min(100, Number(q.points) || 1)),
    })),
  };
  saveQuiz(quiz);
  if (state.currentIndex >= quiz.questions.length) {
    state.currentIndex = Math.max(0, quiz.questions.length - 1);
  }
  broadcastState();
  res.json({ ok: true, quiz });
});

app.post('/api/upload', (req, res) => {
  try {
    const { dataUrl, filename } = req.body || {};
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid image data' });
    }
    const matches = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/i);
    if (!matches) {
      return res.status(400).json({ error: 'Unsupported image format' });
    }
    const ext = matches[1].toLowerCase() === 'jpeg' ? 'jpg' : matches[1].toLowerCase();
    const buffer = Buffer.from(matches[2], 'base64');
    const safeName = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buffer);
    res.json({ url: `/uploads/${safeName}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save image' });
  }
});

// --- Socket.IO Events ---
io.on('connection', (socket) => {
  socket.on('host:join', () => {
    socket.join('host');
    socket.emit('state:update', buildPublicState(true));
  });

  socket.on('host:start', () => {
    if (quiz.questions.length === 0) return;
    startQuestion(0);
  });

  socket.on('host:reveal', () => {
    revealAnswer();
  });

  socket.on('host:leaderboard', () => {
    clearTimer();
    state.phase = 'leaderboard';
    broadcastState();
  });

  socket.on('host:next', () => {
    if (state.currentIndex + 1 < quiz.questions.length) {
      startQuestion(state.currentIndex + 1);
    } else {
      clearTimer();
      state.phase = 'finished';
      broadcastState();
    }
  });

  socket.on('host:reset', ({ keepPlayers = false, newPin = false } = {}) => {
    clearTimer();
    state.phase = 'lobby';
    state.currentIndex = 0;
    state.timeLeft = 0;
    if (newPin) {
      state.pin = generatePin();
    }
    if (!keepPlayers) {
      state.players.clear();
    } else {
      for (const p of state.players.values()) {
        p.score = 0;
        p.streak = 0;
        p.lastPoints = 0;
        p.lastCorrect = null;
        p.answeredCurrent = false;
        p.currentChoice = null;
      }
    }
    broadcastState();
  });

  socket.on('player:join', ({ pin, name, avatar, playerId } = {}, cb) => {
    const cleanPin = String(pin || '').trim();
    if (cleanPin !== state.pin) {
      if (cb) cb({ ok: false, error: 'Invalid room PIN. Please check the screen and try again.' });
      return;
    }

    const cleanName = String(name || '').trim().slice(0, 24);
    if (!cleanName) {
      if (cb) cb({ ok: false, error: 'Please enter your name.' });
      return;
    }

    let player = playerId && state.players.get(playerId);
    if (player) {
      player.name = cleanName;
      player.avatar = avatar || player.avatar;
      player.socketId = socket.id;
    } else {
      const id = playerId || crypto.randomUUID();
      player = {
        id,
        name: cleanName,
        avatar: avatar || '🧠',
        score: 0,
        streak: 0,
        lastPoints: 0,
        lastCorrect: null,
        answeredCurrent: false,
        currentChoice: null,
        socketId: socket.id,
      };
      state.players.set(id, player);
    }

    socket.join('players');
    socket.data.playerId = player.id;
    if (cb) cb({ ok: true, playerId: player.id, player });
    broadcastState();
  });

  socket.on('player:answer', ({ playerId, choice } = {}, cb) => {
    const id = playerId || socket.data.playerId;
    const player = state.players.get(id);
    if (!player || state.phase !== 'question' || player.answeredCurrent) {
      if (cb) cb({ ok: false });
      return;
    }

    const q = quiz.questions[state.currentIndex];
    if (!q || typeof choice !== 'number' || choice < 0 || choice >= q.options.length) {
      if (cb) cb({ ok: false });
      return;
    }

    const isCorrect = choice === q.correctIndex;
    let earned = 0;
    if (isCorrect) {
      earned = Number(q.points) || 1;
      player.streak += 1;
    } else {
      player.streak = 0;
    }

    player.score += earned;
    player.lastPoints = earned;
    player.lastCorrect = isCorrect;
    player.answeredCurrent = true;
    player.currentChoice = choice;

    if (cb) cb({ ok: true, choice });
    broadcastState();

    // Auto-reveal if every connected player has answered
    const allAnswered = state.players.size > 0 && Array.from(state.players.values()).every((p) => p.answeredCurrent);
    if (allAnswered) {
      setTimeout(() => {
        if (state.phase === 'question') revealAnswer();
      }, 600);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLocalLanIp();
  console.log(`\n========================================`);
  console.log(`  Live Quiz Server Running!`);
  console.log(`  Host Screen:  http://localhost:${PORT}`);
  console.log(`  LAN Join URL: http://${lanIp}:${PORT}/play?pin=${state.pin}`);
  console.log(`  Room PIN:     ${state.pin}`);
  console.log(`========================================\n`);
});
