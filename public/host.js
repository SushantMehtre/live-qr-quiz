const socket = io();

const LETTERS = ['A', 'B', 'C', 'D'];
let liveState = null;
let joinBaseUrl = '';
let editableQuiz = null;
let selectedEditIndex = 0;

// DOM Refs
const $ = (id) => document.getElementById(id);

const viewLobby = $('viewLobby');
const viewQuestion = $('viewQuestion');
const viewLeaderboard = $('viewLeaderboard');
const viewFinished = $('viewFinished');

async function initInfoAndQr() {
  const res = await fetch('/api/info');
  const info = await res.json();
  if (!joinBaseUrl) {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    joinBaseUrl = isLocal ? 'https://0504af7150b7ed.app.lhr.life' : window.location.origin;
    $('customBaseUrl').value = joinBaseUrl;
  }
  await refreshQr(info.pin);
}

async function refreshQr(pin) {
  const cleanBase = joinBaseUrl.replace(/\/+$/, '');
  const fullUrl = `${cleanBase}/play?pin=${pin}`;
  $('joinBaseText').textContent = `${cleanBase}/play`;
  const res = await fetch(`/api/qr?url=${encodeURIComponent(fullUrl)}`);
  const data = await res.json();
  $('lobbyQrImg').src = data.dataUrl;
  $('modalQrImg').src = data.dataUrl;
}

function showOnlyView(view) {
  viewLobby.style.display = view === 'lobby' ? 'grid' : 'none';
  viewQuestion.style.display = view === 'question' ? 'flex' : 'none';
  viewLeaderboard.style.display = view === 'leaderboard' ? 'block' : 'none';
  viewFinished.style.display = view === 'finished' ? 'block' : 'none';
}

function updateTimerUI(timeLeft) {
  const ring = $('qTimerRing');
  $('qTimerText').textContent = `${timeLeft}s`;
  if (timeLeft <= 5 && liveState?.phase === 'question') {
    ring.classList.add('urgent');
  } else {
    ring.classList.remove('urgent');
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderState(st) {
  liveState = st;
  $('topQuizTitle').textContent = st.title;
  $('topQuizSub').textContent = st.subtitle || 'Scan QR code to participate';
  $('topPin').textContent = st.pin;
  $('lobbyPin').textContent = st.pin;
  $('modalPin').textContent = st.pin;
  $('topPlayersCount').textContent = st.totalPlayers;
  $('lobbyCountBig').textContent = st.totalPlayers;
  $('lobbyQuestionCount').textContent = `${st.totalQuestions} multiple-choice questions ready`;

  if (!joinBaseUrl) {
    initInfoAndQr();
  }

  if (st.phase === 'lobby') {
    showOnlyView('lobby');
    const grid = $('lobbyPlayersGrid');
    if (st.leaderboard.length === 0) {
      grid.innerHTML = `<div style="color:var(--text-muted); font-size:0.95rem;">Participants will appear here as soon as they scan the QR code...</div>`;
    } else {
      grid.innerHTML = st.leaderboard
        .map((p) => `<div class="player-chip"><span>${p.avatar}</span><span>${escapeHtml(p.name)}</span></div>`)
        .join('');
    }
    return;
  }

  if (st.phase === 'question' || st.phase === 'reveal') {
    showOnlyView('question');
    const q = st.question;
    if (!q) return;

    $('qCounter').textContent = `Question ${st.currentIndex + 1} of ${st.totalQuestions}`;
    $('qAnsweredCount').textContent = `${st.answeredCount} / ${st.totalPlayers}`;
    updateTimerUI(st.timeLeft);
    $('qText').textContent = q.text;

    const qCard = $('questionCard');
    const imgWrap = $('qImageWrap');
    if (q.image) {
      qCard.classList.add('has-image');
      imgWrap.style.display = 'flex';
      $('qImage').src = q.image;
    } else {
      qCard.classList.remove('has-image');
      imgWrap.style.display = 'none';
    }

    const optGrid = $('qOptionsGrid');
    optGrid.innerHTML = q.options
      .map((opt, idx) => {
        let extraClass = '';
        if (st.phase === 'reveal') {
          extraClass = idx === q.correctIndex ? 'correct-glow' : 'dimmed';
        }
        return `
          <div class="option-card ${extraClass}" data-idx="${idx}">
            <div class="option-badge">${LETTERS[idx] || idx + 1}</div>
            <div>${escapeHtml(opt)}</div>
          </div>
        `;
      })
      .join('');

    if (st.phase === 'reveal') {
      $('btnRevealAnswer').style.display = 'none';
      $('btnShowLeaderboard').style.display = 'inline-flex';
      $('revealChartCard').style.display = 'block';
      $('correctAnswerBanner').textContent = `✓ Correct: ${LETTERS[q.correctIndex]}. ${q.options[q.correctIndex]}`;

      const votes = st.votes || q.options.map(() => 0);
      const totalVotes = votes.reduce((a, b) => a + b, 0);
      const maxVote = Math.max(1, ...votes);

      $('chartBars').innerHTML = q.options
        .map((opt, idx) => {
          const count = votes[idx] || 0;
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
          const heightPct = totalVotes > 0 ? Math.round((count / maxVote) * 100) : 0;
          const isCorr = idx === q.correctIndex;
          return `
            <div class="chart-col ${isCorr ? 'is-correct' : ''}">
              <div class="chart-count">${count} (${pct}%)</div>
              <div class="chart-bar-wrap">
                <div class="chart-bar-fill" data-idx="${idx}" style="height:${heightPct}%"></div>
              </div>
              <div class="chart-label">${LETTERS[idx]} ${isCorr ? '✓' : ''}</div>
            </div>
          `;
        })
        .join('');
    } else {
      $('btnRevealAnswer').style.display = 'inline-flex';
      $('btnShowLeaderboard').style.display = 'none';
      $('revealChartCard').style.display = 'none';
    }
    return;
  }

  if (st.phase === 'leaderboard') {
    showOnlyView('leaderboard');
    $('lbSubtitle').textContent = `Standings after Question ${st.currentIndex + 1} of ${st.totalQuestions}`;
    $('btnNextQuestion').textContent =
      st.currentIndex + 1 < st.totalQuestions ? 'Next Question →' : '🏆 Final Podium →';

    const list = $('leaderboardList');
    if (st.leaderboard.length === 0) {
      list.innerHTML = `<div style="color:var(--text-muted); text-align:center; padding:24px;">No participants yet.</div>`;
    } else {
      list.innerHTML = st.leaderboard
        .slice(0, 15)
        .map((p, i) => {
          const medal = p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : `#${p.rank}`;
          const rankClass = p.rank <= 3 ? `rank-${p.rank}` : '';
          const deltaHtml = p.lastPoints > 0 ? `<span class="lb-delta">+${p.lastPoints}</span>` : '';
          const streakHtml = p.streak >= 2 ? `<span title="Answer Streak">🔥${p.streak}</span>` : '';
          return `
            <div class="lb-row ${rankClass}" style="animation-delay:${i * 0.05}s;">
              <div class="lb-left">
                <div class="lb-rank">${medal}</div>
                <div class="lb-avatar">${p.avatar}</div>
                <div class="lb-name">${escapeHtml(p.name)} ${streakHtml}</div>
              </div>
              <div class="lb-right">
                ${deltaHtml}
                <div class="lb-score">${p.score.toLocaleString()} pts</div>
              </div>
            </div>
          `;
        })
        .join('');
    }
    return;
  }

  if (st.phase === 'finished') {
    showOnlyView('finished');
    const top3 = st.leaderboard.slice(0, 3);
    const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
    $('podiumWrap').innerHTML = podiumOrder
      .map((p) => {
        const cls = p.rank === 1 ? 'podium-1' : p.rank === 2 ? 'podium-2' : 'podium-3';
        return `
          <div class="podium-col ${cls}">
            <div class="podium-avatar">${p.avatar}</div>
            <div class="podium-name">${escapeHtml(p.name)}</div>
            <div class="podium-pts">${p.score.toLocaleString()} pts</div>
            <div class="podium-block">${p.rank}</div>
          </div>
        `;
      })
      .join('');

    $('finalLeaderboardList').innerHTML = st.leaderboard
      .map(
        (p) => `
        <div class="lb-row ${p.rank <= 3 ? `rank-${p.rank}` : ''}">
          <div class="lb-left">
            <div class="lb-rank">#${p.rank}</div>
            <div class="lb-avatar">${p.avatar}</div>
            <div class="lb-name">${escapeHtml(p.name)}</div>
          </div>
          <div class="lb-right">
            <div class="lb-score">${p.score.toLocaleString()} pts</div>
          </div>
        </div>`
      )
      .join('');
  }
}

// --- Socket Listeners ---
socket.on('connect', () => {
  socket.emit('host:join');
});

socket.on('state:update', (st) => {
  const prevPin = liveState?.pin;
  renderState(st);
  if (prevPin && prevPin !== st.pin) {
    refreshQr(st.pin);
  }
});

socket.on('timer:tick', ({ timeLeft }) => {
  updateTimerUI(timeLeft);
});

// --- Host Controls ---
$('btnUpdateQr').addEventListener('click', () => {
  const val = $('customBaseUrl').value.trim();
  if (val && liveState) {
    joinBaseUrl = val;
    refreshQr(liveState.pin);
  }
});

$('btnStartQuiz').addEventListener('click', () => socket.emit('host:start'));
$('btnRevealAnswer').addEventListener('click', () => socket.emit('host:reveal'));
$('btnShowLeaderboard').addEventListener('click', () => socket.emit('host:leaderboard'));
$('btnNextQuestion').addEventListener('click', () => socket.emit('host:next'));
$('btnPlayAgain').addEventListener('click', () => socket.emit('host:reset', { keepPlayers: true, newPin: false }));
$('btnNewSession').addEventListener('click', () => socket.emit('host:reset', { keepPlayers: false, newPin: true }));
$('btnResetLobby').addEventListener('click', () => {
  if (confirm('Return to Lobby and reset current scores?')) {
    socket.emit('host:reset', { keepPlayers: true, newPin: false });
  }
});

// QR Modal & Lightbox
$('btnShowQrModal').addEventListener('click', () => $('qrModal').classList.add('open'));
$('btnCloseQrModal').addEventListener('click', () => $('qrModal').classList.remove('open'));
$('qImageWrap').addEventListener('click', () => {
  $('lightboxImg').src = $('qImage').src;
  $('lightbox').classList.add('open');
});
$('lightbox').addEventListener('click', () => $('lightbox').classList.remove('open'));

// --- Quiz Editor ---
async function openEditor() {
  const res = await fetch('/api/quiz');
  editableQuiz = await res.json();
  selectedEditIndex = 0;
  $('editQuizTitle').value = editableQuiz.title || '';
  renderEditorSidebar();
  loadQuestionIntoForm();
  $('editorModal').classList.add('open');
}

function renderEditorSidebar() {
  const list = $('editorQuestionList');
  list.innerHTML = editableQuiz.questions
    .map(
      (q, i) => `
      <div class="q-list-item ${i === selectedEditIndex ? 'active' : ''}" data-index="${i}">
        <span>Q${i + 1}: ${escapeHtml(q.text.replace(/\n/g, ' '))}</span>
        ${q.image ? '<small>🖼️</small>' : ''}
      </div>
    `
    )
    .join('');

  list.querySelectorAll('.q-list-item').forEach((el) => {
    el.addEventListener('click', () => {
      syncFormToQuestion();
      selectedEditIndex = Number(el.dataset.index);
      renderEditorSidebar();
      loadQuestionIntoForm();
    });
  });
}

function loadQuestionIntoForm() {
  const q = editableQuiz.questions[selectedEditIndex];
  if (!q) return;

  $('editQText').value = q.text || '';
  $('editQTime').value = q.timeLimit || 30;
  $('editQPoints').value = q.points || 1000;
  $('editQImageInput').value = '';

  const preview = $('editQImagePreview');
  if (q.image) {
    preview.src = q.image;
    preview.style.display = 'block';
    $('btnRemoveImage').style.display = 'inline-flex';
  } else {
    preview.style.display = 'none';
    $('btnRemoveImage').style.display = 'none';
  }

  const container = $('editOptionsContainer');
  container.innerHTML = q.options
    .map(
      (opt, idx) => `
      <div class="option-edit-row">
        <input type="radio" name="correctOpt" value="${idx}" ${idx === q.correctIndex ? 'checked' : ''} title="Mark as correct answer" />
        <strong style="width:22px;">${LETTERS[idx]}</strong>
        <input type="text" class="input-dark edit-opt-input" data-idx="${idx}" value="${escapeHtml(opt)}" />
      </div>
    `
    )
    .join('');
}

function syncFormToQuestion() {
  const q = editableQuiz?.questions[selectedEditIndex];
  if (!q) return;
  q.text = $('editQText').value;
  q.timeLimit = Number($('editQTime').value) || 30;
  q.points = Number($('editQPoints').value) || 1000;
  const optInputs = document.querySelectorAll('.edit-opt-input');
  q.options = Array.from(optInputs).map((inp) => inp.value);
  const checked = document.querySelector('input[name="correctOpt"]:checked');
  q.correctIndex = checked ? Number(checked.value) : 0;
}

$('editQImageInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: reader.result, filename: file.name }),
    });
    const data = await res.json();
    if (data.url) {
      editableQuiz.questions[selectedEditIndex].image = data.url;
      $('editQImagePreview').src = data.url;
      $('editQImagePreview').style.display = 'block';
      $('btnRemoveImage').style.display = 'inline-flex';
      renderEditorSidebar();
    }
  };
  reader.readAsDataURL(file);
});

$('btnRemoveImage').addEventListener('click', () => {
  editableQuiz.questions[selectedEditIndex].image = null;
  $('editQImagePreview').style.display = 'none';
  $('btnRemoveImage').style.display = 'none';
  renderEditorSidebar();
});

$('btnAddQuestion').addEventListener('click', () => {
  syncFormToQuestion();
  editableQuiz.questions.push({
    id: `q_${Date.now()}`,
    text: 'New Multiple Choice Question',
    image: null,
    options: ['Option A', 'Option B', 'Option C', 'Option D'],
    correctIndex: 0,
    timeLimit: 30,
    points: 1,
  });
  selectedEditIndex = editableQuiz.questions.length - 1;
  renderEditorSidebar();
  loadQuestionIntoForm();
});

$('btnDeleteQuestion').addEventListener('click', () => {
  if (editableQuiz.questions.length <= 1) {
    alert('Quiz must have at least 1 question.');
    return;
  }
  editableQuiz.questions.splice(selectedEditIndex, 1);
  selectedEditIndex = Math.max(0, selectedEditIndex - 1);
  renderEditorSidebar();
  loadQuestionIntoForm();
});

$('btnMoveUp').addEventListener('click', () => {
  if (selectedEditIndex <= 0) return;
  syncFormToQuestion();
  const arr = editableQuiz.questions;
  [arr[selectedEditIndex - 1], arr[selectedEditIndex]] = [arr[selectedEditIndex], arr[selectedEditIndex - 1]];
  selectedEditIndex--;
  renderEditorSidebar();
  loadQuestionIntoForm();
});

$('btnMoveDown').addEventListener('click', () => {
  if (selectedEditIndex >= editableQuiz.questions.length - 1) return;
  syncFormToQuestion();
  const arr = editableQuiz.questions;
  [arr[selectedEditIndex + 1], arr[selectedEditIndex]] = [arr[selectedEditIndex], arr[selectedEditIndex + 1]];
  selectedEditIndex++;
  renderEditorSidebar();
  loadQuestionIntoForm();
});

$('btnSaveQuiz').addEventListener('click', async () => {
  syncFormToQuestion();
  editableQuiz.title = $('editQuizTitle').value.trim() || editableQuiz.title;
  const res = await fetch('/api/quiz', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(editableQuiz),
  });
  if (res.ok) {
    $('editorModal').classList.remove('open');
  } else {
    alert('Failed to save quiz.');
  }
});

$('btnOpenEditor').addEventListener('click', openEditor);
$('btnOpenEditorFromLobby').addEventListener('click', openEditor);
$('btnCloseEditor').addEventListener('click', () => $('editorModal').classList.remove('open'));
