/* ==========================================================================
 * 启思 AI 家教 — 数据与埋点层  (store.js)
 * --------------------------------------------------------------------------
 * 一切结论都从「埋点事件」推导（对齐 PRD 第 9 章）：
 *   掌握度、错题本、家长周报、首页指标 全部由 events 聚合而来，不硬编码。
 * 数据落 localStorage，刷新不丢，能体现「越用越准」。
 * ======================================================================== */
(function (global) {
  'use strict';
  const KEY = 'qisi_state_v1';
  const D = global.QisiData;

  const blank = () => ({
    events: [],          // 埋点事件流（事实来源）
    wrongbook: [],       // 错题本记录 {problemId, knowledgeId, reason, masteryTagAtEntry, ts}
    resume: null,        // 「继续上次」未完成的会话快照
    weekSnapshots: [],   // 每次生成周报时的快照，用于环比
    createdAt: Date.now()
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign(blank(), JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return blank();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function reset() { state = blank(); save(); }

  /* ---------- 埋点 ---------- */
  function track(type, payload) {
    const ev = Object.assign({ type: type, ts: Date.now() }, payload || {});
    state.events.push(ev);
    save();
    if (global.QisiApp && global.QisiApp.onEvent) global.QisiApp.onEvent(ev);
    return ev;
  }
  const events = () => state.events.slice();

  /* ---------- 错题本（自动归集，PRD 6.3.2） ---------- */
  // 入库条件：用过 ③/④ 档提示 或 某步连续答错≥3次 或 最终未独立做出
  function addWrong(rec) {
    state.wrongbook = state.wrongbook.filter(w => w.problemId !== rec.problemId);
    state.wrongbook.push(Object.assign({ ts: Date.now() }, rec));
    save();
  }
  function removeWrong(problemId) {
    state.wrongbook = state.wrongbook.filter(w => w.problemId !== problemId);
    save();
  }
  const wrongbook = () => state.wrongbook.slice();

  /* ---------- 继续上次 ---------- */
  function setResume(snap) { state.resume = snap; save(); }
  function clearResume() { state.resume = null; save(); }
  const getResume = () => state.resume;

  /* ---------- 掌握度计算（三档滚动，PRD 6.3.2） ---------- */
  // 对每个知识点，取其全部 guide_solved/guide_giveup 事件，算独立做出率与平均提示档，
  // 综合为 0–100 分，再映射 薄弱/一般/牢固。
  function masteryFor(knowledgeId) {
    const solves = state.events.filter(
      e => (e.type === 'guide_solved' || e.type === 'guide_giveup') && e.knowledgeId === knowledgeId
    );
    if (!solves.length) return { score: null, tier: '未练习', attempts: 0, indepRate: 0, avgHint: 0 };
    let indep = 0, hintSum = 0;
    solves.forEach(e => {
      if (e.type === 'guide_solved' && e.independent) indep++;
      hintSum += (e.hintLevel != null ? e.hintLevel : 4);
    });
    const indepRate = indep / solves.length;
    const avgHint = hintSum / solves.length;                 // 0–4
    const score = Math.max(0, Math.min(100, Math.round(indepRate * 70 + (1 - avgHint / 4) * 30)));
    const tier = score >= 70 ? '牢固' : score >= 40 ? '一般' : '薄弱';
    return { score, tier, attempts: solves.length, indepRate, avgHint };
  }

  // 所有「练习过」的知识点掌握度，按分数升序（薄弱在前）
  function masteryList() {
    return D.KNOWLEDGE
      .map(k => Object.assign({ id: k.id, name: k.name, category: k.category }, masteryFor(k.id)))
      .filter(m => m.attempts > 0)
      .sort((a, b) => a.score - b.score);
  }

  /* ---------- 周/累计指标聚合 ---------- */
  const WEEK_MS = 7 * 24 * 3600 * 1000;
  function solvedEvents(sinceTs) {
    return state.events.filter(e => e.type === 'guide_solved' && (!sinceTs || e.ts >= sinceTs));
  }
  // 独立做题率 = 独立做出题数 / 已得出结论题数
  function independentRate(sinceTs) {
    const s = solvedEvents(sinceTs);
    if (!s.length) return null;
    return s.filter(e => e.independent).length / s.length;
  }
  function avgHintLevel(sinceTs) {
    const s = solvedEvents(sinceTs);
    if (!s.length) return null;
    return s.reduce((a, e) => a + (e.hintLevel || 0), 0) / s.length;
  }
  function totalGuided() { return solvedEvents().length; }

  // 连续学习天数（按事件日期粗略估算）
  function streakDays() {
    const days = new Set(state.events.map(e => new Date(e.ts).toDateString()));
    return Math.max(days.size, state.events.length ? 1 : 0);
  }

  /* ---------- 家长周报数据（PRD 6.4） ---------- */
  function buildReport() {
    const since = Date.now() - WEEK_MS;
    const solved = solvedEvents(since);
    const last = state.weekSnapshots.length ? state.weekSnapshots[state.weekSnapshots.length - 1] : null;

    const rate = independentRate(since);
    const avgHint = avgHintLevel(since);
    const weak = masteryList().slice(0, 3);

    const enough = solved.length >= 3;     // 数据是否充足（阈值）
    let delta = null, hintDelta = null;
    if (last) {
      if (rate != null && last.rate != null) delta = rate - last.rate;
      if (avgHint != null && last.avgHint != null) hintDelta = avgHint - last.avgHint;
    }

    return {
      enough,
      guidedCount: solved.length,
      rate, delta,
      avgHint, hintDelta,
      weak,
      advice: buildAdvice(enough, rate, weak, hintDelta),
      hasBaseline: !!last
    };
  }

  // AI 建议（本期为规则模板；接 LLM 后由 QisiLLM.generateAdvice 生成）。
  // 约束：正向、可执行、不制造焦虑、无排名/贬低（PRD 6.4.3 / 7.2）。
  function buildAdvice(enough, rate, weak, hintDelta) {
    if (global.QisiLLM && global.QisiLLM.generateAdvice) {
      try { return global.QisiLLM.generateAdvice({ enough, rate, weak, hintDelta }); } catch (e) {}
    }
    if (!enough) {
      return '本周练习题量还不多，先不急着下结论。可以陪孩子保持每天拍 1–2 道不会的题，养成「先想再问」的习惯，下周我们就能看到更清晰的趋势啦。';
    }
    const w = weak[0];
    const trend = (hintDelta != null && hintDelta < -0.05)
      ? '而且这周看提示比上周更少了，越来越独立 💪'
      : '整体很稳，继续保持就好。';
    if (w && w.name.indexOf('应用题') >= 0) {
      return '孩子方程计算已经比较稳，' + trend + '目前在「' + w.name +
        '」上审题时容易丢条件。建议本周陪她一起朗读 2–3 道应用题，只读题、不解题，帮她养成「先把已知量圈出来」的习惯。';
    }
    if (w) {
      return '这周孩子的独立解题表现不错，' + trend + '可以多陪她练几道「' + w.name +
        '」的同类题，这是目前相对薄弱的点，巩固后会更有信心。';
    }
    return '孩子这周状态很好，独立解题比例不错，' + trend + '保持节奏即可。';
  }

  // 生成周报后存快照，供下次环比
  function snapshotReport(r) {
    state.weekSnapshots.push({ ts: Date.now(), rate: r.rate, avgHint: r.avgHint, guidedCount: r.guidedCount });
    save();
  }

  global.QisiStore = {
    track, events,
    addWrong, removeWrong, wrongbook,
    setResume, clearResume, getResume,
    masteryFor, masteryList,
    independentRate, avgHintLevel, totalGuided, streakDays,
    buildReport, snapshotReport,
    reset, _raw: () => state
  };
})(window);
