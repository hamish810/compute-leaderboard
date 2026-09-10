const MAX_RUNS = 30;
const MAX_SCORE = 10_000_000;
const MAX_OPS = 1e12;

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function rankedRuns(runs) {
  return (Array.isArray(runs) ? runs : [])
    .filter((row) => row && Number(row.score) > 0)
    .map((row) => ({
      score: Math.floor(Number(row.score)) || 0,
      ops: Math.floor(Number(row.ops)) || 0,
      at: Math.floor(Number(row.at)) || 0,
    }))
    .filter((row) => row.score > 0 && row.score <= MAX_SCORE && row.ops >= 0 && row.ops <= MAX_OPS)
    .sort((a, b) => b.score - a.score || b.ops - a.ops)
    .slice(0, MAX_RUNS);
}

function snapshotFrom(priv, extraRun) {
  const prev = asObject(priv);
  const runs = rankedRuns(extraRun ? [...(prev.runs || []), extraRun] : prev.runs);
  const top = runs[0] || null;
  return {
    best: top ? top.score : 0,
    bestOps: top ? top.ops : 0,
    bestAt: top ? top.at : 0,
    published: Math.floor(Number(prev.published)) || 0,
    runs,
  };
}

function pickName(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  }
  return "";
}

function profileName(ctx) {
  try {
    const user = asObject(ctx && ctx.user);
    return pickName(user.name, user.username);
  } catch {
    return "";
  }
}

function isBetterPublic(next, published) {
  const current = Math.floor(Number(published)) || 0;
  return next.score > current;
}

export default {
  async run(input, ctx) {
    const action = input && typeof input.action === "string" ? input.action : "";

    if (action === "who") {
      return { ok: true, name: profileName(ctx) };
    }

    if (action === "submit") {
      const score = Math.floor(Number(input.score));
      const ops = Math.floor(Number(input.ops));
      if (!Number.isFinite(score) || score < 1 || score > MAX_SCORE) {
        return { ok: false, error: "invalid score" };
      }
      if (!Number.isFinite(ops) || ops < 0 || ops > MAX_OPS) {
        return { ok: false, error: "invalid ops" };
      }

      const at = Date.now();
      const run = { score, ops, at };
      const save = snapshotFrom(await ctx.db.get(), run);
      const improved = isBetterPublic(run, save.published);

      if (improved) {
        save.published = score;
        await ctx.public.put({
          score,
          ops,
          at,
        });
      }

      await ctx.db.set(save);
      return { ok: true, improved, data: save, name: profileName(ctx) };
    }

    return { ok: false, error: "unknown action" };
  },
};
