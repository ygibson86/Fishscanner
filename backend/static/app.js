// ---------------------------------------------------------------------------
// FishScanner web aquarium.
// Fish animation logic (rise -> swim -> bounce off walls, bubbles) is ported
// from the original project's ocean/drawingfish.py so it feels the same as
// the desktop OpenGL version, just rendered with 2D canvas instead of GL.
// ---------------------------------------------------------------------------

const canvas = document.getElementById('aquarium');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const toastEl = document.getElementById('toast');
const fileInput = document.getElementById('file-input');
const bgToggleBtn = document.getElementById('bg-toggle-btn');
const bgPanel = document.getElementById('bg-panel');
const bgGalleryEl = document.getElementById('bg-gallery');
const bgFileInput = document.getElementById('bg-file-input');
const bgFilterButtons = document.querySelectorAll('.bg-filter-swatch');
const installBtn = document.getElementById('install-btn');
const printToggleBtn = document.getElementById('print-toggle-btn');
const printPanel = document.getElementById('print-panel');
const printGalleryEl = document.getElementById('print-gallery');
const printFileInput = document.getElementById('print-file-input');
const printBlankBtn = document.getElementById('print-blank-btn');
const printDownloadBtn = document.getElementById('print-download-btn');
const deleteConfirmEl = document.getElementById('delete-confirm');
const deleteConfirmYesBtn = document.getElementById('delete-confirm-yes');
const deleteConfirmNoBtn = document.getElementById('delete-confirm-no');

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

function showToast(text, isError = false) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  toastEl.style.background = isError ? 'rgba(120,30,30,0.92)' : 'rgba(20,40,55,0.92)';
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 3200);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// --- Background --------------------------------------------------------------------
const ASSET = (name) => `/assets/${name}`;

function drawCover(img) {
  const scale = Math.max(canvas.width / img.width, canvas.height / img.height) * 1.05;
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}

// Lighting filters, applied as a tint on top of whichever background is
// currently active (default artwork OR a custom uploaded image).
const FILTER_TINTS = {
  day: { color: 'rgba(255,255,255,0.14)', op: 'lighten' },
  dusk: { color: 'rgba(255,110,50,0.30)', op: 'multiply' },
  night: { color: 'rgba(5,10,35,0.65)', op: 'multiply' },
};

class Seaweed {
  constructor(img, xFrac, yFrac, wFrac, hFrac, swaySpeed, swayAmount) {
    this.img = img;
    this.xFrac = xFrac; this.yFrac = yFrac;
    this.wFrac = wFrac; this.hFrac = hFrac;
    this.swaySpeed = swaySpeed;
    this.swayAmount = swayAmount;
    this.phase = Math.random() * Math.PI * 2;
  }
  draw(t) {
    const w = this.wFrac * canvas.width;
    const h = this.hFrac * canvas.height;
    const x = this.xFrac * canvas.width;
    const y = this.yFrac * canvas.height;
    const angle = Math.sin(t * this.swaySpeed + this.phase) * this.swayAmount;
    ctx.save();
    ctx.translate(x, y + h);
    ctx.rotate(angle);
    ctx.drawImage(this.img, -w / 2, -h, w, h);
    ctx.restore();
  }
}

class Bubble {
  constructor(img, x, y) {
    this.img = img;
    this.x = x;
    this.y = y;
    this.size = 6 + Math.random() * 10;
    this.speedY = -(0.4 + Math.random() * 0.5);
    this.driftX = (Math.random() - 0.5) * 0.4;
    this.alpha = 0.85;
  }
  update() {
    this.y += this.speedY;
    this.x += this.driftX;
    this.alpha -= 0.002;
  }
  get dead() { return this.y < -20 || this.alpha <= 0; }
  draw() {
    ctx.save();
    ctx.globalAlpha = Math.max(this.alpha, 0);
    ctx.drawImage(this.img, this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
    ctx.restore();
  }
}

// --- Fish --------------------------------------------------------------------------
class Fish {
  constructor(img, bubbleImg, id) {
    this.id = id;
    this.img = img;
    this.bubbleImg = bubbleImg;

    const aspect = img.width / img.height;
    this.h = 90 + Math.random() * 50;
    this.w = this.h * aspect;

    this.flipped = Math.random() < 0.5;

    // normalized swim area (fractions of canvas) - almost the whole screen,
    // leaving a small margin at the very top/bottom edges
    this.left = 0.04;
    this.right = 0.96;
    this.top = 0.08;
    this.bottom = 0.90;

    this.x = this.left + Math.random() * (this.right - this.left);
    this.x *= canvas.width;

    // Rise-in animation: start below the screen and ease up to a random
    // point inside the swim area, so fish actually spread across the whole
    // aquarium instead of stalling near the bottom.
    this.startY = canvas.height + this.h;
    this.targetY = (this.top + Math.random() * (this.bottom - this.top)) * canvas.height;
    this.y = this.startY;
    this.riseProgress = 0;
    this.riseDuration = 70 + Math.floor(Math.random() * 40);

    this.vx = 0;
    this.vy = 0;

    this.stage = 'init';

    this.bubbleFrequency = 90; // higher = rarer
    this.bubbles = [];

    this.wobblePhase = Math.random() * Math.PI * 2;
    this.wobbleOffset = 0;
    this.spin = 0; // extra rotation applied briefly when bouncing off a wall
  }

  _initFishVelocity() {
    const dir = this.flipped ? -1 : 1;
    this.vx = dir * (0.55 + Math.random() * 0.35);
    this.vy = (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.25);
    this.bubbleFrequency = 260;
  }

  _spawnBubbleMaybe() {
    if (Math.random() < 1 / this.bubbleFrequency) {
      const bx = this.x + (this.flipped ? this.w * 0.3 : -this.w * 0.3);
      this.bubbles.push(new Bubble(this.bubbleImg, bx, this.y - this.h * 0.2));
    }
    this.bubbles = this.bubbles.filter(b => !b.dead);
    this.bubbles.forEach(b => b.update());
  }

  update(t) {
    this.x += this.vx;
    this.y += this.vy;
    this._spawnBubbleMaybe();

    const leftPx = this.left * canvas.width;
    const rightPx = this.right * canvas.width;
    const topPx = this.top * canvas.height;
    const bottomPx = this.bottom * canvas.height;

    if (this.stage === 'init') {
      this.riseProgress += 1;
      const progress = Math.min(this.riseProgress / this.riseDuration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      this.y = this.startY + (this.targetY - this.startY) * eased;
      if (progress >= 1) {
        this._initFishVelocity();
        this.stage = 'swim';
      }
    } else if (this.stage === 'swim') {
      if (this.x > rightPx || this.x < leftPx) {
        this.vx = -this.vx;
        this.flipped = !this.flipped;
        this.spin = 1; // trigger a quick flip animation
      }
      if (this.y > bottomPx || this.y < topPx) {
        this.vy = -this.vy;
      }
      if (this.spin > 0) {
        this.spin = Math.max(0, this.spin - 0.06);
      }
    }

    // gentle up/down wobble while swimming, like the shader's sine wave
    this.wobbleOffset = Math.sin(t * 2 + this.wobblePhase) * 4;
  }

  // Axis-aligned hit test in canvas-pixel coordinates (used for right-click /
  // long-press deletion). Good enough approximation - ignores the flip/spin
  // skew, which only matters for a couple of frames during a wall-bounce.
  containsPoint(px, py) {
    const halfW = this.w / 2;
    const halfH = this.h / 2;
    const fy = this.y + this.wobbleOffset;
    return px >= this.x - halfW && px <= this.x + halfW && py >= fy - halfH && py <= fy + halfH;
  }

  draw() {
    this.bubbles.forEach(b => b.draw());

    ctx.save();
    ctx.translate(this.x, this.y + (this.wobbleOffset || 0));
    const flipScale = this.flipped ? -1 : 1;
    const spinSquash = 1 - this.spin; // squashes width to fake a turn-around flip
    ctx.scale(flipScale * Math.max(spinSquash, 0.15), 1);
    ctx.drawImage(this.img, -this.w / 2, -this.h / 2, this.w, this.h);
    ctx.restore();
  }
}

// --- Aquarium scene ------------------------------------------------------------------
class Aquarium {
  constructor() {
    this.seaweeds = [];
    this.fish = [];
    this.bubbleImg = null;
    this.t = 0;

    this.defaultBgImage = null;
    this.background = { base: { type: 'reef' }, filter: 'none', gallery: [] };
    this.customBgImage = null;
  }

  async setBackgroundState(state) {
    this.background = state;
    if (state.base.type === 'custom' && state.base.url) {
      try {
        this.customBgImage = await loadImage(state.base.url);
      } catch (e) {
        this.customBgImage = null;
      }
    } else {
      this.customBgImage = null;
    }
    renderBackgroundPanel(state);
  }

  async init() {
    const [backDefault, seaweed1, seaweed2, seaweed3, bubble] = await Promise.all([
      loadImage(ASSET('back_default.png')),
      loadImage(ASSET('seaweed_1.png')),
      loadImage(ASSET('seaweed_2.png')),
      loadImage(ASSET('seaweed_3.png')),
      loadImage(ASSET('bubble.png')),
    ]);

    this.defaultBgImage = backDefault;
    this.bubbleImg = bubble;

    this.seaweeds = [
      new Seaweed(seaweed2, 0.62, 0.98, 0.22, 0.32, 0.6, 0.06),
      new Seaweed(seaweed1, 0.85, 1.0, 0.28, 0.45, 0.5, 0.05),
      new Seaweed(seaweed3, 0.08, 1.0, 0.18, 0.4, 0.55, 0.07),
      new Seaweed(seaweed1, 0.35, 1.0, 0.14, 0.22, 0.7, 0.08),
    ];
  }

  addFish(img, id) {
    this.fish.push(new Fish(img, this.bubbleImg, id));
  }

  removeFishById(id) {
    this.fish = this.fish.filter(f => f.id !== id);
  }

  findFishAt(x, y) {
    // topmost drawn (last in array) first
    for (let i = this.fish.length - 1; i >= 0; i--) {
      if (this.fish[i].containsPoint(x, y)) return this.fish[i];
    }
    return null;
  }

  update() {
    this.t += 1 / 60;
    this.fish.forEach(f => f.update(this.t));
  }

  draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.background.base.type === 'custom' && this.customBgImage) {
      drawCover(this.customBgImage);
    } else if (this.defaultBgImage) {
      drawCover(this.defaultBgImage);
    }

    const tint = FILTER_TINTS[this.background.filter];
    if (tint) {
      ctx.save();
      ctx.globalCompositeOperation = tint.op;
      ctx.fillStyle = tint.color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }

    this.seaweeds.forEach(s => s.draw(this.t));
    this.fish.forEach(f => f.draw());
  }
}

const aquarium = new Aquarium();

function loop() {
  aquarium.update();
  aquarium.draw();
  requestAnimationFrame(loop);
}

// --- Background panel: gallery of saved backgrounds + lighting filters -------------
async function selectBackgroundBase(payload) {
  try {
    const res = await fetch('/api/background/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('request failed');
    const state = await res.json();
    await aquarium.setBackgroundState(state);
  } catch (e) {
    showToast('Не удалось сменить фон', true);
  }
}

async function deleteBackground(id) {
  try {
    const res = await fetch(`/api/background/custom/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('request failed');
    const state = await res.json();
    await aquarium.setBackgroundState(state);
  } catch (e) {
    showToast('Не удалось удалить фон', true);
  }
}

function renderBackgroundPanel(state) {
  bgGalleryEl.innerHTML = '';

  const reefBtn = document.createElement('button');
  reefBtn.className = 'bg-thumb' + (state.base.type === 'reef' ? ' active' : '');
  reefBtn.style.backgroundImage = `url("${ASSET('back_default.png')}")`;
  reefBtn.style.backgroundSize = 'cover';
  reefBtn.textContent = 'По умолчанию';
  reefBtn.addEventListener('click', () => selectBackgroundBase({ type: 'reef' }));
  bgGalleryEl.appendChild(reefBtn);

  state.gallery.forEach((item) => {
    const btn = document.createElement('button');
    const isActive = state.base.type === 'custom' && state.base.id === item.id;
    btn.className = 'bg-thumb' + (isActive ? ' active' : '');
    btn.style.backgroundImage = `url("${item.url}")`;
    btn.addEventListener('click', () => selectBackgroundBase({ type: 'custom', id: item.id }));

    const del = document.createElement('span');
    del.className = 'bg-thumb-delete';
    del.textContent = '×';
    del.title = 'Удалить фон';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteBackground(item.id);
    });
    btn.appendChild(del);
    bgGalleryEl.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'bg-thumb bg-thumb-add';
  addBtn.textContent = '+ Свой фон';
  addBtn.addEventListener('click', () => bgFileInput.click());
  bgGalleryEl.appendChild(addBtn);

  bgFilterButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === state.filter);
  });
}

bgToggleBtn.addEventListener('click', () => {
  bgPanel.classList.toggle('hidden');
});

document.addEventListener('click', (event) => {
  // .contains() rather than !== because the print button holds an inline SVG
  // and then event.target is the <path>, not the button itself
  if (!bgPanel.contains(event.target) && !bgToggleBtn.contains(event.target) && !bgPanel.classList.contains('hidden')) {
    bgPanel.classList.add('hidden');
  }
  // Clicking outside closes the print panel too; because the toggle button of
  // one panel is "outside" the other, opening one closes the other automatically.
  if (!printPanel.contains(event.target) && !printToggleBtn.contains(event.target) && !printPanel.classList.contains('hidden')) {
    printPanel.classList.add('hidden');
  }
});

bgFilterButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/background/filter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filter: btn.dataset.filter }),
      });
      if (!res.ok) throw new Error('request failed');
      const state = await res.json();
      await aquarium.setBackgroundState(state);
    } catch (e) {
      showToast('Не удалось применить освещение', true);
    }
  });
});

bgFileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  showToast('Загружаю новый фон…');
  const formData = new FormData();
  formData.append('photo', file);

  try {
    const res = await fetch('/api/background/custom', { method: 'POST', body: formData });
    if (!res.ok) throw new Error('request failed');
    const state = await res.json();
    await aquarium.setBackgroundState(state);
    showToast('Фон добавлен!');
  } catch (e) {
    showToast('Не удалось загрузить фон', true);
  } finally {
    bgFileInput.value = '';
  }
});

// --- Print panel: images -> PDF sheets with ArUco markers ---------------------------
const printItems = []; // {file, name, url, selected}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function renderPrintPanel() {
  printGalleryEl.innerHTML = '';
  printGalleryEl.style.display = printItems.length ? 'grid' : 'none';

  printItems.forEach((item) => {
    const thumb = document.createElement('div');
    thumb.className = 'print-thumb' + (item.selected ? ' active' : '');
    thumb.style.backgroundImage = `url("${item.url}")`;
    thumb.title = item.name;
    thumb.addEventListener('click', () => {
      item.selected = !item.selected;
      renderPrintPanel();
    });

    const del = document.createElement('span');
    del.className = 'print-thumb-delete';
    del.textContent = '×';
    del.title = 'Убрать картинку';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      URL.revokeObjectURL(item.url);
      printItems.splice(printItems.indexOf(item), 1);
      renderPrintPanel();
    });
    thumb.appendChild(del);
    printGalleryEl.appendChild(thumb);
  });

  const selectedCount = printItems.filter((item) => item.selected).length;
  printDownloadBtn.classList.toggle('hidden', selectedCount === 0);
  printDownloadBtn.textContent = `⬇️ Скачать PDF (${selectedCount})`;
}

printToggleBtn.addEventListener('click', () => {
  printPanel.classList.toggle('hidden');
});

printBlankBtn.addEventListener('click', async () => {
  showToast('Готовлю бланк для печати…');
  try {
    const res = await fetch('/api/pdf/blank');
    if (!res.ok) throw new Error('request failed');
    downloadBlob(await res.blob(), 'fish_pattern.pdf');
    showToast('📄 Бланк скачивается — распечатайте его');
  } catch (e) {
    showToast('Не удалось получить бланк', true);
  }
});

printFileInput.addEventListener('change', (event) => {
  const files = Array.from(event.target.files || []);
  files.forEach((file) => {
    printItems.push({ file, name: file.name, url: URL.createObjectURL(file), selected: true });
  });
  if (files.length) renderPrintPanel();
  printFileInput.value = '';
});

printDownloadBtn.addEventListener('click', async () => {
  const selected = printItems.filter((item) => item.selected);
  if (!selected.length) return;

  const formData = new FormData();
  selected.forEach((item) => formData.append('files', item.file, item.name));

  showToast(`Собираю PDF: ${selected.length} лист(ов)…`);
  try {
    const res = await fetch('/api/pdf', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.detail || 'Не удалось собрать PDF', true);
      return;
    }
    downloadBlob(await res.blob(), 'fish_print.pdf');
    showToast(`📄 PDF готов: ${selected.length} лист(ов)`);
  } catch (e) {
    showToast('Ошибка соединения с сервером', true);
  }
});

renderPrintPanel();

// --- Delete a fish: right-click (desktop) or long-press (touch) -------------------
let pendingDeleteFishId = null;
let longPressTimer = null;
let longPressFish = null;
let touchStartPos = null;
const LONG_PRESS_MS = 550;
const LONG_PRESS_MOVE_TOLERANCE = 14;

function canvasPoint(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

function showDeleteConfirm(fish, clientX, clientY) {
  pendingDeleteFishId = fish.id;
  const x = Math.min(Math.max(clientX, 90), window.innerWidth - 90);
  const y = Math.max(clientY, 80);
  deleteConfirmEl.style.left = `${x}px`;
  deleteConfirmEl.style.top = `${y}px`;
  deleteConfirmEl.classList.remove('hidden');
}

function hideDeleteConfirm() {
  deleteConfirmEl.classList.add('hidden');
  pendingDeleteFishId = null;
}

canvas.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const p = canvasPoint(event.clientX, event.clientY);
  const fish = aquarium.findFishAt(p.x, p.y);
  if (fish) showDeleteConfirm(fish, event.clientX, event.clientY);
});

canvas.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) return;
  const t = event.touches[0];
  touchStartPos = { x: t.clientX, y: t.clientY };
  const p = canvasPoint(t.clientX, t.clientY);
  const fish = aquarium.findFishAt(p.x, p.y);
  if (!fish) return;
  longPressFish = fish;
  longPressTimer = setTimeout(() => {
    if (longPressFish) {
      if (navigator.vibrate) navigator.vibrate(30);
      showDeleteConfirm(longPressFish, touchStartPos.x, touchStartPos.y);
    }
  }, LONG_PRESS_MS);
}, { passive: true });

canvas.addEventListener('touchmove', (event) => {
  if (!touchStartPos || event.touches.length !== 1) return;
  const t = event.touches[0];
  const dx = t.clientX - touchStartPos.x;
  const dy = t.clientY - touchStartPos.y;
  if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_TOLERANCE) {
    clearTimeout(longPressTimer);
    longPressFish = null;
  }
}, { passive: true });

canvas.addEventListener('touchend', () => {
  clearTimeout(longPressTimer);
  longPressFish = null;
  touchStartPos = null;
});

deleteConfirmYesBtn.addEventListener('click', async () => {
  const id = pendingDeleteFishId;
  hideDeleteConfirm();
  if (!id) return;
  try {
    const res = await fetch(`/api/fish/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('request failed');
    aquarium.removeFishById(id); // instant feedback; the ws broadcast will also confirm it
  } catch (e) {
    showToast('Не удалось удалить рыбку', true);
  }
});

deleteConfirmNoBtn.addEventListener('click', hideDeleteConfirm);

// --- Networking: initial fish list + live updates over websocket --------------------
async function loadBackground() {
  try {
    const res = await fetch('/api/background');
    const state = await res.json();
    await aquarium.setBackgroundState(state);
  } catch (e) {
    console.error('Failed to load background state', e);
  }
}

async function loadExistingFish() {
  try {
    const res = await fetch('/api/fish');
    const list = await res.json();
    for (const entry of list) {
      try {
        const img = await loadImage(entry.url);
        aquarium.addFish(img, entry.id);
      } catch (e) { /* skip broken file */ }
    }
  } catch (e) {
    console.error('Failed to load existing fish', e);
  }
}

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/aquarium`);

  ws.onopen = () => {
    statusEl.textContent = 'подключено';
    statusEl.className = 'status connected';
  };
  ws.onclose = () => {
    statusEl.textContent = 'нет соединения, переподключение…';
    statusEl.className = 'status disconnected';
    setTimeout(connectWebSocket, 2000);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'new_fish') {
      try {
        const img = await loadImage(msg.fish.url);
        aquarium.addFish(img, msg.fish.id);
        showToast('🐟 Новая рыбка приплыла в аквариум!');
      } catch (e) { /* ignore */ }
    } else if (msg.type === 'removed_fish') {
      aquarium.removeFishById(msg.id);
    } else if (msg.type === 'background_changed') {
      await aquarium.setBackgroundState(msg.background);
      showToast('🎨 Кто-то сменил фон аквариума');
    }
  };
}

// --- Upload handling (photo taken directly in the browser too) ---------------------
fileInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  showToast('Обрабатываю фото рыбки…');
  const formData = new FormData();
  formData.append('photo', file);

  try {
    const res = await fetch('/api/fish', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.detail || 'Не удалось распознать рыбку. Попробуйте другое фото.', true);
      return;
    }
    // The fish will actually be added via the websocket broadcast,
    // this toast is just immediate feedback.
    showToast('Готово! Рыбка добавляется в аквариум…');
  } catch (e) {
    showToast('Ошибка соединения с сервером', true);
  } finally {
    fileInput.value = '';
  }
});

// --- PWA: service worker + "Install app" button --------------------------------------
if ('serviceWorker' in navigator) {
  // Service workers only register on secure contexts (HTTPS or localhost).
  // On a plain-http LAN address this silently does nothing - the app still
  // works fine, it just won't cache the shell for offline use.
  navigator.serviceWorker.register('/service-worker.js').catch(() => {});
}

let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installBtn.classList.remove('hidden');
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBtn.classList.add('hidden');
});

window.addEventListener('appinstalled', () => {
  installBtn.classList.add('hidden');
  showToast('Приложение установлено на экран «Домой»!');
});

// --- Boot ----------------------------------------------------------------------------
(async function boot() {
  await aquarium.init();
  await loadBackground();
  await loadExistingFish();
  connectWebSocket();
  loop();
})();
