const socket = io();

const AVATARS = ['🧠', '🩺', '🔬', '🧬', '⚡', '🦊', '🦉', '🚀', '🎯', '🌟', '🐼', '🦁'];
const LETTERS = ['A', 'B', 'C', 'D'];

const $ = (id) => document.getElementById(id);

let selectedAvatar = localStorage.getItem('quiz_avatar') || AVATARS[0];
let playerId = localStorage.getItem('quiz_player_id') || null;
let joined = false;
let pickedChoice = null;
let lastQuestionIndex = -1;

// Pre-fill PIN from QR URL
const params = new URLSearchParams(window.location.search);
if (params.get('pin')) {
  $('inputPin').value = params.get('pin');
}
if (localStorage.getItem('quiz_name')) {
  $('inputName').value = localStorage.getItem('quiz_name');
}

// Render Avatar Picker
$('avatarGrid').innerHTML = AVATARS.map(
  (av) => `<button type="button" class="avatar-btn ${av === selectedAvatar ? 'selected' : ''}" data-av="${av}">${av}</button>`
).join('');

$('avatarGrid').querySelectorAll('.avatar-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    selectedAvatar = btn.dataset.av;
    localStorage.setItem('quiz_avatar', selectedAvatar);
    $('avatarGrid').querySelectorAll('.avatar-btn').forEach((b) => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
});

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showSection(name) {
  $('playJoin').style.display = name === 'join' ? 'flex' : 'none';
  $('playWaiting').style.display = name === 'waiting' ? 'block' : 'none';
  $('playQuestion').style.display = name === 'question' ? 'flex' : 'none';
  $('playResult').style.display = name === 'result' ? 'flex' : 'none';
  $('playHeader').style.display = name === 'join' ? 'none' : 'flex';
}

function attemptJoin(pin, name, avatar, existingId) {
  socket.emit('player:join', { pin, name, avatar, playerId: existingId }, (res) => {
    if (!res || !res.ok) {
      $('joinError').textContent = res?.error || 'Could not join.';
      $('joinError').style.display = 'block';
      joined = false;
      showSection('join');
      return;
    }
    joined = true;
    playerId = res.playerId;
    localStorage.setItem('quiz_player_id', playerId);
    localStorage.setItem('quiz_name', name);
    localStorage.setItem('quiz_avatar', avatar);
    $('joinError').style.display = 'none';
    $('myAvatarBadge').textContent = avatar;
    $('myNameBadge').textContent = name;
    $('waitAvatar').textContent = avatar;
  });
}

$('btnJoin').addEventListener('click', () => {
  const pin = $('inputPin').value.trim();
  const name = $('inputName').value.trim();
  attemptJoin(pin, name, selectedAvatar, playerId);
});

socket.on('connect', () => {
  const savedPin = params.get('pin') || $('inputPin').value.trim();
  const savedName = localStorage.getItem('quiz_name');
  if (playerId && savedPin && savedName) {
    attemptJoin(savedPin, savedName, selectedAvatar, playerId);
  }
});

socket.on('timer:tick', ({ timeLeft }) => {
  $('playTimer').textContent = `${timeLeft}s`;
});

socket.on('state:update', (st) => {
  if (!joined) return;

  const me = st.leaderboard.find((p) => p.id === playerId);
  if (me) {
    $('myScoreBadge').textContent = `${me.score.toLocaleString()} pts`;
    $('myRankBadge').textContent = `Rank #${me.rank} of ${st.totalPlayers}`;
  }

  if (st.phase === 'lobby') {
    pickedChoice = null;
    lastQuestionIndex = -1;
    showSection('waiting');
    return;
  }

  if (st.phase === 'question') {
    showSection('question');
    if (lastQuestionIndex !== st.currentIndex) {
      lastQuestionIndex = st.currentIndex;
      pickedChoice = null;
    }
    const q = st.question;
    $('playQCounter').textContent = `Q${st.currentIndex + 1} / ${st.totalQuestions}`;
    $('playTimer').textContent = `${st.timeLeft}s`;
    $('playQText').textContent = q.text;

    if (q.image) {
      $('playQImgWrap').style.display = 'block';
      $('playQImg').src = q.image;
    } else {
      $('playQImgWrap').style.display = 'none';
    }

    const alreadyAnswered = me?.answeredCurrent || pickedChoice !== null;
    $('playLockedMsg').style.display = alreadyAnswered ? 'block' : 'none';

    $('playOptions').innerHTML = q.options
      .map((opt, idx) => {
        let cls = '';
        if (alreadyAnswered) {
          cls = idx === pickedChoice ? 'picked' : 'faded';
        }
        return `
          <button type="button" class="play-opt-btn ${cls}" data-idx="${idx}" ${alreadyAnswered ? 'disabled' : ''}>
            <span class="option-badge">${LETTERS[idx]}</span>
            <span>${escapeHtml(opt)}</span>
          </button>
        `;
      })
      .join('');

    if (!alreadyAnswered) {
      $('playOptions').querySelectorAll('.play-opt-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const choice = Number(btn.dataset.idx);
          pickedChoice = choice;
          socket.emit('player:answer', { playerId, choice }, (res) => {
            if (res?.ok) {
              $('playLockedMsg').style.display = 'block';
              $('playOptions').querySelectorAll('.play-opt-btn').forEach((b) => {
                b.disabled = true;
                b.classList.add(Number(b.dataset.idx) === choice ? 'picked' : 'faded');
              });
            }
          });
        });
      });
    }
    return;
  }

  if (st.phase === 'reveal') {
    showSection('result');
    $('playMiniLb').innerHTML = '';
    const q = st.question;
    const correctText = `${LETTERS[q.correctIndex]}. ${q.options[q.correctIndex]}`;
    if (me?.lastCorrect === true) {
      $('resIcon').textContent = '🎉';
      $('resTitle').textContent = `Correct! +${me.lastPoints} pt${me.lastPoints === 1 ? '' : 's'}`;
      $('resTitle').style.color = '#34d399';
      $('resSub').textContent = `Answer: ${correctText}`;
    } else if (me?.lastCorrect === false) {
      $('resIcon').textContent = '😅';
      $('resTitle').textContent = 'Not quite! (0 pts)';
      $('resTitle').style.color = '#fda4af';
      $('resSub').textContent = `Correct answer: ${correctText}`;
    } else {
      $('resIcon').textContent = '⏱️';
      $('resTitle').textContent = "Time's up! (0 pts)";
      $('resTitle').style.color = '#fbbf24';
      $('resSub').textContent = `Correct answer: ${correctText}`;
    }
    $('resStats').textContent = me ? `Total: ${me.score.toLocaleString()} pt${me.score === 1 ? '' : 's'} • Rank #${me.rank}` : '';
    return;
  }

  if (st.phase === 'leaderboard' || st.phase === 'finished') {
    showSection('result');
    $('resIcon').textContent = st.phase === 'finished' ? '🏆' : '📊';
    $('resTitle').textContent = st.phase === 'finished' ? 'Final Standings' : 'Leaderboard';
    $('resTitle').style.color = '#fff';
    $('resSub').textContent = me ? `You are #${me.rank} of ${st.totalPlayers}` : '';
    $('resStats').textContent = me ? `Score: ${me.score.toLocaleString()} pts` : '';

    $('playMiniLb').innerHTML = st.leaderboard
      .slice(0, 5)
      .map(
        (p) => `
        <div class="lb-row ${p.rank <= 3 ? `rank-${p.rank}` : ''}" style="padding:10px 14px;">
          <div class="lb-left">
            <div class="lb-rank" style="font-size:1rem;">#${p.rank}</div>
            <div class="lb-avatar" style="font-size:1.25rem;">${p.avatar}</div>
            <div class="lb-name" style="font-size:0.95rem;">${escapeHtml(p.name)} ${p.id === playerId ? '(You)' : ''}</div>
          </div>
          <div class="lb-score" style="font-size:1rem;">${p.score.toLocaleString()}</div>
        </div>`
      )
      .join('');
  }
});

// Lightbox for mobile image zoom
$('playQImgWrap').addEventListener('click', () => {
  $('playLightboxImg').src = $('playQImg').src;
  $('playLightbox').classList.add('open');
});
$('playLightbox').addEventListener('click', () => $('playLightbox').classList.remove('open'));
