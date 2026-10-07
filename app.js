'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  images: [],        // { file, url }
  participants: [],  // string[]
  winners: [],       // string[]
  results: [],       // { name, item }
  spinning: false,
  drawing: false,
};

// glyph palette: lime, win, warn, rank-silver, lime-accent, lose-light, rank-bronze
const WHEEL_COLORS = ['#ffff7c', '#6ee7b7', '#ffb432', '#cdd2dc', '#c5fa3b', '#cc7f86', '#cd7f32'];

// ── fair randomness (crypto) ────────────────────────────────
function randInt(n) {
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= max);
  return buf[0] % n;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── sound effects (8-bit synth via Web Audio, no files) ─
const SOUND_KEY = 'random-draw:sound';
const sfx = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem(SOUND_KEY) === 'off'; } catch {}

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, dur, { type = 'square', vol = 0.06, at = 0, slideTo } = {}) {
    if (muted) return;
    const a = ac();
    const t = a.currentTime + at;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  const notes = (seq, step, opts) => seq.forEach((f, i) => tone(f, step * 1.6, { ...opts, at: i * step }));

  return {
    get muted() { return muted; },
    setMuted(v) {
      muted = v;
      try { localStorage.setItem(SOUND_KEY, v ? 'off' : 'on'); } catch {}
    },
    // slot name flicker
    blip: () => tone(880, 0.04, { vol: 0.035 }),
    // wheel slice passing the pointer
    tick: () => tone(1500, 0.025, { type: 'triangle', vol: 0.09 }),
    // a winner lands in the slot
    hit: () => notes([523.25, 659.25, 783.99, 1046.5], 0.07, { vol: 0.07 }),
    // wheel stops on an item
    prize: () => {
      notes([783.99, 987.77, 1174.66, 1567.98], 0.08, { vol: 0.07 });
      tone(1567.98, 0.5, { at: 0.32, type: 'triangle', vol: 0.06 });
    },
    // spin start whoosh
    whoosh: () => tone(180, 0.35, { type: 'sawtooth', vol: 0.04, slideTo: 900 }),
    // results screen
    fanfare: () => {
      notes([523.25, 523.25, 523.25, 698.46], 0.12, { vol: 0.07 });
      notes([880, 1046.5], 0.18, { vol: 0.07, at: 0 });
      tone(1046.5, 0.8, { at: 0.66, type: 'triangle', vol: 0.07 });
      tone(523.25, 0.8, { at: 0.66, vol: 0.04 });
    },
  };
})();

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2200);
}

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── screen navigation ───────────────────────────────────────────
function goTo(step) {
  for (const n of [1, 2, 3]) $(`#step${n}`).hidden = n !== step;
  document.querySelectorAll('.step-dot').forEach((d) => {
    d.classList.toggle('active', Number(d.dataset.step) === step);
  });
  if (step === 2) { renderStep2List(); drawWheel(); }
  if (step === 3) { renderResults(); sfx.fanfare(); }
}

// ── participants ─────────────────────────────────────────
function addParticipant(name) {
  name = name.trim();
  if (!name) return false;
  const key = name.toLowerCase();
  if (state.participants.some((p) => p.toLowerCase() === key)) return false;
  state.participants.push(name);
  return true;
}

function removeParticipant(name) {
  state.participants = state.participants.filter((p) => p !== name);
  renderAll();
}

function renderAll() {
  renderStep1List();
  renderStep2List();
}

function renderStep1List() {
  $('#s1Count').textContent = state.participants.length;
  $('#s1List').innerHTML = state.participants
    .map((p, i) => `<span class="chip">${esc(p)}<button data-i="${i}" title="Remove">×</button></span>`)
    .join('');
  $('#toStep2').disabled = state.participants.length === 0;
}

function renderStep2List() {
  $('#s2Count').textContent = state.participants.length;
  $('#s2List').innerHTML = state.participants
    .map((p, i) => `<li class="${state.winners.includes(p) ? 'won' : ''}"><div><span>${esc(p)}</span><button data-i="${i}" title="Remove">×</button></div></li>`)
    .join('');
  $('#drawCount').max = Math.max(1, state.participants.length);
}

$('#s1List').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b) removeParticipant(state.participants[Number(b.dataset.i)]);
});
$('#s2List').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (b && !state.drawing) removeParticipant(state.participants[Number(b.dataset.i)]);
});

function bindAddForm(formSel, inputSel) {
  $(formSel).addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $(inputSel);
    if (addParticipant(input.value)) { input.value = ''; renderAll(); }
    else if (input.value.trim()) toast('Already in the list');
  });
}
bindAddForm('#s1AddForm', '#s1AddInput');
bindAddForm('#s2AddForm', '#s2AddInput');

// ── STEP 1: image upload ──────────────────────────────
function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    state.images.push({ file, url: URL.createObjectURL(file) });
  }
  renderThumbs();
}

function renderThumbs() {
  $('#thumbs').innerHTML = state.images
    .map((img, i) => `<div class="thumb"><img src="${img.url}" alt="" /><button data-i="${i}" title="Remove">×</button></div>`)
    .join('');
  $('#ocrBtn').disabled = state.images.length === 0;
}

$('#thumbs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  const [removed] = state.images.splice(Number(b.dataset.i), 1);
  URL.revokeObjectURL(removed.url);
  renderThumbs();
});

$('#fileInput').addEventListener('change', (e) => { addImages(e.target.files); e.target.value = ''; });

const dz = $('#dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  addImages(e.dataTransfer.files);
});

document.addEventListener('paste', (e) => {
  if ($('#step1').hidden) return;
  const files = [...e.clipboardData.items]
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile());
  if (files.length) { addImages(files); toast(`Added ${files.length} screenshot${files.length > 1 ? 's' : ''}`); }
});

// ── STEP 1: OCR ─────────────────────────────────────────
// Upscale 2x + grayscale, invert if dark mode → better recognition
function preprocess(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = img.width * scale;
      c.height = img.height * scale;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      const px = data.data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) {
        const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        px[i] = px[i + 1] = px[i + 2] = g;
        sum += g;
      }
      if (sum / (px.length / 4) < 128) {
        for (let i = 0; i < px.length; i += 4) px[i] = px[i + 1] = px[i + 2] = 255 - px[i];
      }
      ctx.putImageData(data, 0, 0);
      resolve(c);
    };
    img.onerror = reject;
    img.src = url;
  });
}

function extractHandles(text) {
  // OCR sometimes reads @ as © or ®
  const fixed = text.replace(/[©®]/g, '@');
  const found = [];
  for (const m of fixed.matchAll(/@([A-Za-z0-9_]{2,15})/g)) found.push('@' + m[1]);
  return found;
}

let rawLines = [];

$('#ocrBtn').addEventListener('click', async () => {
  if (!window.Tesseract) { toast('Could not load the OCR library (check your connection)'); return; }
  const btn = $('#ocrBtn');
  const status = $('#ocrStatus');
  const bar = $('#ocrBar');
  btn.disabled = true;

  const total = state.images.length;
  let current = 0;
  status.textContent = 'Preparing OCR engine… (first run downloads language data)';
  bar.style.width = '0%';

  let worker;
  try {
    worker = await Tesseract.createWorker(['kor', 'eng'], 1, {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          bar.style.width = `${((current + m.progress) / total) * 100}%`;
        }
      },
    });

    const lineSet = new Set(rawLines);
    let added = 0;
    for (current = 0; current < total; current++) {
      status.textContent = `Recognizing… ${current + 1} / ${total}`;
      const canvas = await preprocess(state.images[current].url);
      const { data } = await worker.recognize(canvas);
      for (const h of extractHandles(data.text)) if (addParticipant(h)) added++;
      for (const line of data.text.split('\n')) {
        const t = line.trim();
        if (t.length >= 2) lineSet.add(t);
      }
    }
    rawLines = [...lineSet];
    bar.style.width = '100%';
    status.textContent = `Done! ${added} new @handle${added === 1 ? '' : 's'} added`;
    renderRawLines();
    renderAll();
  } catch (err) {
    console.error(err);
    status.textContent = 'Something went wrong during recognition. Please try again.';
  } finally {
    if (worker) await worker.terminate();
    btn.disabled = state.images.length === 0;
  }
});

function renderRawLines() {
  $('#rawWrap').hidden = rawLines.length === 0;
  $('#rawLines').innerHTML = rawLines
    .map((l, i) => `<span class="chip" data-i="${i}">${esc(l)}</span>`)
    .join('');
}

// Click a text line → put it in the input to trim, then add
$('#rawLines').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-i]');
  if (!chip) return;
  const input = $('#s1AddInput');
  input.value = rawLines[Number(chip.dataset.i)];
  input.focus();
  input.select();
});

$('#toStep2').addEventListener('click', () => goTo(2));
$('#backTo1').addEventListener('click', () => goTo(1));

// ── STEP 2: draw ────────────────────────────────────────
async function rollSlot(pool, finalName) {
  const slot = $('#slot');
  const text = $('#slotText');
  slot.classList.remove('hit');
  slot.classList.add('rolling');
  // Slot that gradually slows down
  let delay = 40;
  while (delay < 260) {
    text.textContent = pool[randInt(pool.length)];
    sfx.blip();
    await sleep(delay);
    delay *= 1.12;
  }
  text.textContent = finalName;
  slot.classList.remove('rolling');
  void slot.offsetWidth; // restart animation
  slot.classList.add('hit');
  sfx.hit();
}

$('#drawBtn').addEventListener('click', async () => {
  if (state.drawing || state.spinning) return;
  const pool = state.participants;
  const n = parseInt($('#drawCount').value, 10);
  if (!pool.length) { toast('No participants yet'); return; }
  if (!(n >= 1)) { toast('Enter at least 1'); return; }
  if (n > pool.length) { toast(`There are only ${pool.length} participants`); return; }
  if (state.results.length && !confirm('Drawing again will clear the current results. Continue?')) return;

  state.drawing = true;
  state.winners = [];
  state.results = [];
  $('#drawBtn').disabled = true;
  $('#spinBtn').disabled = true;
  $('#toStep3').hidden = true;
  renderWinners();
  renderStep2List();

  const picked = shuffle(pool).slice(0, n);
  for (const name of picked) {
    await rollSlot(pool, name);
    state.winners.push(name);
    renderWinners();
    renderStep2List();
    await sleep(500);
  }

  state.drawing = false;
  $('#drawBtn').disabled = false;
  updateTurn();
});

function renderWinners() {
  const cur = state.results.length;
  $('#winnerList').innerHTML = state.winners
    .map((w, i) => {
      const r = state.results[i];
      const item = r
        ? `<span class="item">🎁 ${esc(r.item)}</span>`
        : `<span class="item pending">${i === cur && !state.drawing ? 'Waiting for spin' : '—'}</span>`;
      return `<li class="${i === cur && !state.drawing ? 'current' : ''}"><span>${i + 1}. ${esc(w)}</span>${item}</li>`;
    })
    .join('');
}

// ── STEP 2: item wheel ─────────────────────────────────
const ITEMS_KEY = 'random-draw:items';
const itemsInput = $('#itemsInput');
try { itemsInput.value = localStorage.getItem(ITEMS_KEY) || ''; } catch {}

let wheelItems = [];       // items currently on the wheel
let wheelRotation = 0;

function parseItems() {
  return itemsInput.value.split('\n').map((s) => s.trim()).filter(Boolean);
}

// With "remove won items" on, drop already-won items (one per win)
function computeWheelItems() {
  const items = parseItems();
  if (!$('#removeWon').checked) return items;
  const left = items.slice();
  for (const r of state.results) {
    const idx = left.indexOf(r.item);
    if (idx !== -1) left.splice(idx, 1);
  }
  return left;
}

itemsInput.addEventListener('input', () => {
  try { localStorage.setItem(ITEMS_KEY, itemsInput.value); } catch {}
  drawWheel();
  updateTurn();
});
$('#removeWon').addEventListener('change', () => { drawWheel(); updateTurn(); });

const WHEEL_FONT = '"IBM Plex Mono", "IBM Plex Sans KR", monospace';

function sliceColor(i, n) {
  // avoid the same color on the first/last slices
  if (i === n - 1 && i > 0 && i % WHEEL_COLORS.length === 0) return WHEEL_COLORS[3];
  return WHEEL_COLORS[i % WHEEL_COLORS.length];
}

function drawPointer(ctx, cx, top) {
  ctx.beginPath();
  ctx.moveTo(cx - 14, top);
  ctx.lineTo(cx + 14, top);
  ctx.lineTo(cx, top + 26);
  ctx.closePath();
  ctx.fillStyle = '#ffff7c';
  ctx.strokeStyle = '#050506';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
}

function drawWheel() {
  if (!state.spinning) wheelItems = computeWheelItems();
  const canvas = $('#wheel');
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 420;
  const W = Math.round(size * dpr);
  if (canvas.width !== W) { canvas.width = W; canvas.height = W; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2, r = size / 2 - 18;
  const items = wheelItems;

  // outer ring
  ctx.beginPath();
  ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
  ctx.fillStyle = '#d0d2db';
  ctx.fill();

  if (!items.length) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#17171c';
    ctx.fill();
    ctx.fillStyle = '#65676f';
    ctx.font = `500 15px ${WHEEL_FONT}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Add items above', cx, cy + r / 2.4);
  } else {
    const seg = (Math.PI * 2) / items.length;
    const fontSize = Math.max(11, Math.min(18, 200 / items.length + 7));
    items.forEach((item, i) => {
      const start = wheelRotation + i * seg;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + seg);
      ctx.closePath();
      ctx.fillStyle = sliceColor(i, items.length);
      ctx.fill();
      if (items.length > 1) {
        ctx.strokeStyle = '#050506';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + seg / 2);
      ctx.fillStyle = '#0d1a0a';
      ctx.font = `700 ${fontSize}px ${WHEEL_FONT}`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      let label = item;
      const maxW = r - 48;
      while (ctx.measureText(label).width > maxW && label.length > 1) label = label.slice(0, -1);
      if (label !== item) label = label.slice(0, -1) + '…';
      ctx.fillText(label, r - 14, 0);
      ctx.restore();
    });
  }

  // center hub
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2);
  ctx.fillStyle = '#050506';
  ctx.fill();
  ctx.strokeStyle = '#ffff7c';
  ctx.lineWidth = 4;
  ctx.stroke();

  drawPointer(ctx, cx, 2);
}

if (document.fonts) document.fonts.ready.then(drawWheel);
window.addEventListener('resize', drawWheel);

function updateTurn() {
  const label = $('#turnLabel');
  const spinBtn = $('#spinBtn');
  const idx = state.results.length;
  const allDone = state.winners.length > 0 && idx >= state.winners.length;
  $('#toStep3').hidden = !allDone;
  spinBtn.hidden = allDone;
  renderWinners();

  if (!state.winners.length) {
    label.textContent = 'Draw winners first';
    spinBtn.disabled = true;
    return;
  }
  if (allDone) {
    label.textContent = 'All items assigned!';
    return;
  }
  if (!computeWheelItems().length) {
    label.textContent = 'No items left on the wheel';
    spinBtn.disabled = true;
    return;
  }
  label.innerHTML = `Now spinning for <b>${esc(state.winners[idx])}</b>`;
  spinBtn.disabled = state.spinning || state.drawing;
}

const easeOut = (t) => 1 - Math.pow(1 - t, 4);

// Spin once for the current winner; resolves after the wheel stops.
function spinOnce() {
  return new Promise((resolve) => {
    wheelItems = computeWheelItems();
    const n = wheelItems.length;

    // Pick the result first, then compute a rotation that lands near that slice's center
    const k = randInt(n);
    const seg = (Math.PI * 2) / n;
    const jitter = ((randInt(1000) / 1000) - 0.5) * seg * 0.7;
    const pointer = -Math.PI / 2;
    const target = pointer - (k + 0.5) * seg + jitter;
    const TAU = Math.PI * 2;
    const from = wheelRotation;
    const delta = (((target - from) % TAU) + TAU) % TAU + TAU * (6 + randInt(3));
    const duration = 5200;
    const t0 = performance.now();
    // slice under the pointer — a tick plays each time it changes
    const sliceAt = (rot) => Math.floor(((((pointer - rot) % TAU) + TAU) % TAU) / seg);
    let lastSlice = sliceAt(from);
    sfx.whoosh();

    function frame(now) {
      const t = Math.min(1, (now - t0) / duration);
      wheelRotation = from + delta * easeOut(t);
      drawWheel();
      const slice = sliceAt(wheelRotation);
      if (slice !== lastSlice) { lastSlice = slice; sfx.tick(); }
      if (t < 1) { requestAnimationFrame(frame); return; }

      wheelRotation %= TAU;
      const name = state.winners[state.results.length];
      const item = wheelItems[k];
      state.results.push({ name, item });
      toast(`🎁 ${name} → ${item}`);
      sfx.prize();
      renderWinners();
      resolve();
    }
    requestAnimationFrame(frame);
  });
}

// One press spins for every remaining winner in turn.
$('#spinBtn').addEventListener('click', async () => {
  if (state.spinning || state.drawing) return;
  if (!computeWheelItems().length) return;

  state.spinning = true;
  $('#spinBtn').disabled = true;
  $('#drawBtn').disabled = true;
  itemsInput.disabled = true;

  while (state.results.length < state.winners.length && computeWheelItems().length) {
    updateTurn();
    await spinOnce();
    await sleep(500);
    wheelItems = computeWheelItems(); // drop the won item before the next spin
    drawWheel();
  }

  state.spinning = false;
  itemsInput.disabled = false;
  $('#drawBtn').disabled = false;
  updateTurn();
});

$('#toStep3').addEventListener('click', () => goTo(3));

// ── STEP 3: results ────────────────────────────────────────
function renderResults() {
  $('#resultGrid').innerHTML = state.results
    .map((r, i) => `
      <div class="result-card" style="animation-delay:${i * 0.15}s">
        <div class="rank">WINNER ${i + 1}</div>
        <div class="name">${esc(r.name)}</div>
        <div class="prize">🎁 ${esc(r.item)}</div>
      </div>`)
    .join('');
}

$('#backTo2').addEventListener('click', () => goTo(2));
$('#restart').addEventListener('click', () => {
  if (!confirm('Clear participants, screenshots and results and start over? (Item list is kept)')) return;
  state.images.forEach((img) => URL.revokeObjectURL(img.url));
  state.images = [];
  state.participants = [];
  state.winners = [];
  state.results = [];
  rawLines = [];
  $('#ocrStatus').textContent = '';
  $('#ocrBar').style.width = '0%';
  $('#slotText').textContent = 'READY';
  $('#slot').classList.remove('hit');
  renderThumbs();
  renderRawLines();
  renderAll();
  renderWinners();
  updateTurn();
  goTo(1);
});

// ── sound toggle ─────────────────────────────────────
const soundBtn = $('#soundBtn');
function renderSoundBtn() {
  soundBtn.textContent = sfx.muted ? '♪ Sound off' : '♪ Sound on';
  soundBtn.classList.toggle('off', sfx.muted);
}
soundBtn.addEventListener('click', () => {
  sfx.setMuted(!sfx.muted);
  renderSoundBtn();
  sfx.blip();
});
renderSoundBtn();

// ── init ───────────────────────────────────────────────
renderAll();
goTo(1);
