const DURATION_MS = 5000;
const MIN_N = 100_000_000_000; // 12-digit
const MAX_N = 999_999_999_999;
const MAX_BOARD = 25;
const LOCAL_KEY = "compute-lb-player";

const el = {
  name: document.getElementById("name"),
  status: document.getElementById("status"),
  clock: document.getElementById("clock"),
  bar: document.getElementById("bar-fill"),
  liveScore: document.getElementById("live-score"),
  liveOps: document.getElementById("live-ops"),
  run: document.getElementById("run"),
  post: document.getElementById("post"),
  hint: document.getElementById("hint"),
  board: document.getElementById("board"),
  refresh: document.getElementById("refresh"),
  storeNote: document.getElementById("store-note"),
};

const hosted = typeof window.mystack?.db?.get === "function";

function localStore() {
  return {
    async get() {
      try {
        return JSON.parse(localStorage.getItem("compute-lb-db") || "{}");
      } catch {
        return {};
      }
    },
    async set(obj) {
      localStorage.setItem("compute-lb-db", JSON.stringify(obj));
    },
    async delete() {
      localStorage.removeItem("compute-lb-db");
    },
  };
}

const db = hosted ? window.mystack.db : localStore();

function playerId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadPlayer() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const player = {
    id: playerId(),
    name: "",
    best: 0,
  };
  localStorage.setItem(LOCAL_KEY, JSON.stringify(player));
  return player;
}

function savePlayer(player) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(player));
}

let player = loadPlayer();
el.name.value = player.name;

el.storeNote.textContent = hosted
  ? "Scores live in this app’s shared MyStack store (one JSON object). Simultaneous posts can overwrite each other."
  : "Not running on MyStack — the board is saved in this browser only.";

let lastResult = null;
let running = false;

const workerSource = `
  const MIN_N = ${MIN_N};
  const MAX_N = ${MAX_N};

  function randN() {
    const span = MAX_N - MIN_N;
    let n = MIN_N + Math.floor(Math.random() * span);
    if ((n & 1) === 0) n += 1;
    return n;
  }

  function factor(n) {
    let ops = 0;
    let x = n;
    while ((x & 1) === 0) {
      x = Math.floor(x / 2);
      ops++;
    }
    let p = 3;
    while (p * p <= x) {
      ops++;
      while (x % p === 0) {
        x = Math.floor(x / p);
        ops++;
      }
      p += 2;
    }
    return ops;
  }

  self.onmessage = (e) => {
    const duration = e.data.duration;
    const start = performance.now();
    let solved = 0;
    let ops = 0;
    let lastPost = 0;
    while (performance.now() - start < duration) {
      ops += factor(randN());
      solved++;
      const t = performance.now() - start;
      if (t - lastPost > 80) {
        self.postMessage({ type: "progress", solved, ops, t });
        lastPost = t;
      }
    }
    self.postMessage({
      type: "done",
      solved,
      ops,
      t: Math.min(duration, performance.now() - start),
    });
  };
`;

function formatOps(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function setProgress(t, solved, ops) {
  const remain = Math.max(0, DURATION_MS - t);
  const pct = Math.min(100, (t / DURATION_MS) * 100);
  el.clock.textContent = (remain / 1000).toFixed(2) + "s";
  el.bar.style.width = pct + "%";
  el.bar.parentElement.setAttribute("aria-valuenow", String(Math.round(pct)));
  el.liveScore.textContent = String(solved);
  el.liveOps.textContent = formatOps(ops) + " trial divisions";
}

function entriesFrom(data) {
  const board = data && typeof data.board === "object" && !Array.isArray(data.board)
    ? data.board
    : {};
  return Object.entries(board)
    .map(([id, row]) => ({
      id,
      name: typeof row?.name === "string" && row.name.trim() ? row.name.trim().slice(0, 24) : "anonymous",
      score: Number(row?.score) || 0,
      ops: Number(row?.ops) || 0,
      at: Number(row?.at) || 0,
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.ops - a.ops)
    .slice(0, MAX_BOARD);
}

function renderBoard(rows) {
  if (!rows.length) {
    el.board.innerHTML = "<li><span class=\"rank\">—</span><span>No scores yet</span><span></span></li>";
    return;
  }
  el.board.innerHTML = rows
    .map((row, i) => {
      const you = row.id === player.id ? " you" : "";
      const label = row.id === player.id ? `${row.name} (you)` : row.name;
      return `<li class="${you}">
        <span class="rank">${i + 1}</span>
        <span class="name">${escapeHtml(label)}</span>
        <span class="pts">${row.score}</span>
      </li>`;
    })
    .join("");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadBoard() {
  try {
    const data = await db.get();
    renderBoard(entriesFrom(data && typeof data === "object" ? data : {}));
  } catch (err) {
    el.hint.textContent = "Could not read the board.";
    renderBoard([]);
  }
}

async function postScore() {
  if (!lastResult) return;
  player.name = el.name.value.trim().slice(0, 24);
  savePlayer(player);

  const entry = {
    name: player.name || "anonymous",
    score: lastResult.solved,
    ops: lastResult.ops,
    at: Date.now(),
  };

  // MyStack has no atomic update. This replaces the whole store with a
  // snapshot built from the last read, so concurrent posts can drop scores.
  let data = {};
  try {
    const got = await db.get();
    if (got && typeof got === "object" && !Array.isArray(got)) data = got;
  } catch {
    data = {};
  }

  const board =
    data.board && typeof data.board === "object" && !Array.isArray(data.board)
      ? { ...data.board }
      : {};
  board[player.id] = entry;
  const trimmed = Object.fromEntries(
    entriesFrom({ board }).map((row) => [
      row.id,
      { name: row.name, score: row.score, ops: row.ops, at: row.at },
    ])
  );

  await db.set({ board: trimmed });
  renderBoard(entriesFrom({ board: trimmed }));
  el.hint.textContent = "Posted.";
  el.post.disabled = true;
}

function finishRun(solved, ops) {
  running = false;
  lastResult = { solved, ops };
  setProgress(DURATION_MS, solved, ops);
  el.status.textContent = "Done";
  el.run.disabled = false;
  el.post.disabled = false;

  if (solved > player.best) {
    player.best = solved;
    savePlayer(player);
    el.hint.textContent = "Personal best. Post it to the board.";
  } else {
    el.hint.textContent = `Best on this device: ${player.best}.`;
  }
}

function randN() {
  const span = MAX_N - MIN_N;
  let n = MIN_N + Math.floor(Math.random() * span);
  if ((n & 1) === 0) n += 1;
  return n;
}

function factor(n) {
  let ops = 0;
  let x = n;
  while ((x & 1) === 0) {
    x = Math.floor(x / 2);
    ops++;
  }
  let p = 3;
  while (p * p <= x) {
    ops++;
    while (x % p === 0) {
      x = Math.floor(x / p);
      ops++;
    }
    p += 2;
  }
  return ops;
}

function runOnMainThread() {
  const start = performance.now();
  let solved = 0;
  let ops = 0;

  function tick() {
    const sliceEnd = Math.min(performance.now() + 16, start + DURATION_MS);
    while (performance.now() < sliceEnd) {
      ops += factor(randN());
      solved++;
    }
    const t = performance.now() - start;
    if (t >= DURATION_MS) {
      finishRun(solved, ops);
      return;
    }
    setProgress(t, solved, ops);
    setTimeout(tick, 0);
  }

  tick();
}

function runBenchmark() {
  if (running) return;
  running = true;
  lastResult = null;
  el.run.disabled = true;
  el.post.disabled = true;
  el.status.textContent = "Running";
  el.hint.textContent = "";
  setProgress(0, 0, 0);

  try {
    const blob = new Blob([workerSource], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        setProgress(msg.t, msg.solved, msg.ops);
        return;
      }
      worker.terminate();
      URL.revokeObjectURL(url);
      finishRun(msg.solved, msg.ops);
    };

    worker.onerror = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
      runOnMainThread();
    };

    worker.postMessage({ duration: DURATION_MS });
  } catch {
    runOnMainThread();
  }
}

el.name.addEventListener("change", () => {
  player.name = el.name.value.trim().slice(0, 24);
  savePlayer(player);
});

el.run.addEventListener("click", runBenchmark);
el.post.addEventListener("click", () => {
  el.post.disabled = true;
  postScore().catch(() => {
    el.hint.textContent = "Could not post. Try again.";
    el.post.disabled = false;
  });
});
el.refresh.addEventListener("click", () => {
  loadBoard();
});

loadBoard();
