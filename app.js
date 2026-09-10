const DURATION_MS = 5000;
const MIN_N = 100_000_000_000;
const MAX_N = 999_999_999_999;
const MAX_RUNS = 30;
const LOCAL_KEY = "compute-lb-save";

const el = {
  who: document.getElementById("who"),
  account: document.getElementById("account"),
  status: document.getElementById("status"),
  clock: document.getElementById("clock"),
  bar: document.getElementById("bar-fill"),
  liveScore: document.getElementById("live-score"),
  liveOps: document.getElementById("live-ops"),
  run: document.getElementById("run"),
  login: document.getElementById("login"),
  logout: document.getElementById("logout"),
  hint: document.getElementById("hint"),
  board: document.getElementById("board"),
  yours: document.getElementById("yours"),
  refresh: document.getElementById("refresh"),
  storeNote: document.getElementById("store-note"),
};

function api() {
  const m = window.mystack;
  return {
    mystack: !!(m && typeof m === "object"),
    db: typeof m?.db?.get === "function",
    run: typeof m?.run === "function",
    pub: typeof m?.public?.list === "function",
    login: typeof m?.auth?.login === "function",
    logout: typeof m?.auth?.logout === "function",
    session: typeof m?.auth?.session === "function",
  };
}

function localStore() {
  return {
    async get() {
      try {
        return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
      } catch {
        return {};
      }
    },
    async set(obj) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(obj));
    },
  };
}

const localDb = localStore();

let save = {
  best: 0,
  bestOps: 0,
  bestAt: 0,
  published: 0,
  runs: [],
};

let publicRows = [];
let running = false;
let accountSignedIn = false;
const ACCOUNT_KEY = "compute-lb-account";

function accountName(result) {
  const name = typeof result?.name === "string" ? result.name.trim() : "";
  const username = typeof result?.username === "string" ? result.username.trim() : "";
  return name || username || "Signed in";
}

function readAccountCache() {
  try {
    const raw = sessionStorage.getItem(ACCOUNT_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

function writeAccountCache(signedIn, name) {
  try {
    sessionStorage.setItem(
      ACCOUNT_KEY,
      JSON.stringify({
        signedIn: !!signedIn,
        name: signedIn ? name || "Signed in" : "",
      })
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function renderAccount(signedIn, name) {
  const a = api();
  const label = signedIn ? name || "Signed in" : "";
  accountSignedIn = !!signedIn;
  writeAccountCache(signedIn, label);
  el.login.hidden = !(a.login && !signedIn);
  el.logout.hidden = !(a.logout && signedIn);
  if (signedIn) {
    el.who.hidden = false;
    el.who.textContent = label;
  } else {
    el.who.hidden = true;
    el.who.textContent = "";
  }
  el.account.hidden = el.login.hidden && el.logout.hidden && el.who.hidden;
}

function restoreAccount() {
  const cached = readAccountCache();
  if (cached && cached.signedIn) {
    renderAccount(true, cached.name);
  }
}

async function waitForMystack() {
  if (api().mystack) return;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (api().mystack) return;
  }
}

async function refreshSession() {
  await waitForMystack();
  const a = api();
  if (!a.session) return accountSignedIn;
  try {
    const result = await window.mystack.auth.session();
    const signedIn = !!(result && result.signedIn);
    renderAccount(signedIn, accountName(result));
    return signedIn;
  } catch {
    return accountSignedIn;
  }
}

function setStoreNote() {
  const a = api();
  if (!a.mystack) {
    el.storeNote.textContent =
      "This page is not running on MyStack — scores stay in this browser only.";
  } else if (!a.pub || !a.run) {
    el.storeNote.textContent =
      "Public writes are unavailable here. Personal scores still save on this device cookie.";
  } else {
    el.storeNote.textContent =
      "Anyone can run and save. Sign in to publish under your MyStack name; otherwise the board shows Anonymous.";
  }
}

setStoreNote();

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

function formatWhen(at) {
  if (!at) return "";
  try {
    return new Date(at).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
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

function rankedRuns(runs) {
  return [...(runs || [])]
    .filter((row) => row && Number(row.score) > 0)
    .sort((a, b) => b.score - a.score || b.ops - a.ops)
    .slice(0, MAX_RUNS);
}

function applyData(data) {
  const obj = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  save = {
    best: Number(obj.best) || 0,
    bestOps: Number(obj.bestOps) || 0,
    bestAt: Number(obj.bestAt) || 0,
    published: Number(obj.published) || 0,
    runs: Array.isArray(obj.runs) ? obj.runs : [],
  };
  renderYours();
}

function emptyBoard(message) {
  return `<li><span class="rank">—</span><span>${message}</span><span></span></li>`;
}

function renderYours() {
  const rows = rankedRuns(save.runs);
  if (!rows.length) {
    el.yours.innerHTML = emptyBoard("No runs yet");
    return;
  }
  el.yours.innerHTML = rows
    .map((row, i) => {
      const isBest = row.score === save.best && row.at === save.bestAt;
      return `<li class="${isBest ? "best" : ""}">
        <span class="rank">${i + 1}</span>
        <span class="when">${isBest ? "Best · " : ""}${formatWhen(row.at)}</span>
        <span class="pts">${row.score}</span>
      </li>`;
    })
    .join("");
}

function displayName(row) {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  const username = typeof row.username === "string" ? row.username.trim() : "";
  return name || username || "Anonymous";
}

function renderBoard() {
  const ranked = [...publicRows]
    .map((row) => {
      const data = row && row.data && typeof row.data === "object" ? row.data : {};
      return {
        name: displayName(row),
        score: Number(data.score) || 0,
        ops: Number(data.ops) || 0,
        at: Number(data.at) || 0,
      };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || b.ops - a.ops);

  if (!ranked.length) {
    el.board.innerHTML = emptyBoard("No public scores yet");
    return;
  }

  el.board.innerHTML = ranked
    .map(
      (row, i) => `<li>
        <span class="rank">${i + 1}</span>
        <span class="who">${escapeHtml(row.name)}</span>
        <span class="pts">${row.score}</span>
      </li>`
    )
    .join("");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadPrivate() {
  if (!api().db) {
    applyData(await localDb.get());
    return;
  }
  applyData(await window.mystack.db.get());
}

async function loadPublic() {
  if (!api().pub) {
    publicRows = [];
    if (!api().mystack) {
      el.board.innerHTML = emptyBoard("Public board needs MyStack");
    } else {
      renderBoard();
    }
    return;
  }
  const result = await window.mystack.public.list({ order: "score", limit: 50 });
  publicRows = Array.isArray(result?.rows) ? result.rows : [];
  renderBoard();
}

async function loadAll() {
  await waitForMystack();
  setStoreNote();
  await refreshSession();
  await loadPublic();
  await loadPrivate();
}

function localSubmit(solved, ops, at) {
  save.runs = rankedRuns([...save.runs, { score: solved, ops, at }]);
  const top = save.runs[0];
  if (top) {
    save.best = top.score;
    save.bestOps = top.ops;
    save.bestAt = top.at;
  }
  renderYours();
  return localDb.set({
    best: save.best,
    bestOps: save.bestOps,
    bestAt: save.bestAt,
    published: save.published,
    runs: save.runs,
  });
}

async function finishRun(solved, ops) {
  running = false;
  setProgress(DURATION_MS, solved, ops);
  el.status.textContent = "Done";
  el.run.disabled = false;

  const at = Date.now();
  const improvedLocal = solved > save.best;

  try {
    if (api().run) {
      const result = await window.mystack.run({
        action: "submit",
        score: solved,
        ops,
      });
      if (!result || result.ok === false) {
        throw new Error(result?.error || "submit failed");
      }
      if (result.data) applyData(result.data);
      else await loadPrivate();
      await loadPublic();
      el.hint.textContent = result.improved
        ? "New public best — published to the board."
        : `Saved. Personal best: ${save.best}.`;
      return;
    }

    await localSubmit(solved, ops, at);
    el.hint.textContent = improvedLocal
      ? "Personal best — saved in this browser."
      : `Saved locally. Best: ${save.best}.`;
  } catch {
    el.hint.textContent = "Could not save this run.";
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
  el.run.disabled = true;
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

el.run.addEventListener("click", runBenchmark);
el.refresh.addEventListener("click", () => {
  loadAll().catch(() => {
    el.hint.textContent = "Could not reload the board.";
  });
});
el.login.addEventListener("click", () => {
  if (api().login) window.mystack.auth.login();
});
el.logout.addEventListener("click", async () => {
  if (!api().logout) return;
  try {
    await window.mystack.auth.logout();
    applyData({});
    renderAccount(false);
    await loadAll();
  } catch {
    el.hint.textContent = "Sign-out did not complete.";
  }
});

restoreAccount();
renderYours();
renderBoard();

loadAll().catch(() => {
  el.hint.textContent = api().mystack
    ? "Could not load scores."
    : "Could not load saved scores.";
});
