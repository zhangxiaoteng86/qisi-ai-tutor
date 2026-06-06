/* ==========================================================================
 * 启思 AI 家教 — UI 控制层  (app.js)
 * 把题库/状态/引擎接到界面：导航、模拟拍题、引导对话、错题本、知识图谱、
 * 家长周报、埋点面板。
 * ======================================================================== */
(function (global) {
  'use strict';
  const D = QisiData, S = QisiStore, E = QisiEngine;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  let role = 'student';
  let session = null;     // 当前引导会话
  let pendingProblem = null; // OCR 确认中的题
  let suspectShown = false;

  /* ---------------- 导航 ---------------- */
  function tab(v, el) {
    document.querySelectorAll('.view').forEach(x => x.classList.remove('on'));
    const view = $('view-' + v);
    if (view) view.classList.add('on');
    if (el) { el.parentNode.querySelectorAll('button').forEach(b => b.classList.remove('on')); el.classList.add('on'); }
    $('screen').scrollTop = 0;
    if (v === 'home') renderHome();
    if (v === 'shoot') renderShoot();
    if (v === 'book') { S.track('wrongbook_view'); renderBook(); }
    if (v === 'me') renderMe();
    if (v === 'parent') renderParent();
  }
  function setRole(r) {
    role = r;
    const stu = r === 'student';
    $('roleStudent').classList.toggle('on', stu);
    $('roleParent').classList.toggle('on', !stu);
    $('tab-student').style.display = stu ? 'flex' : 'none';
    $('tab-parent').style.display = stu ? 'none' : 'flex';
    closeChat();
    if (stu) { tab('home'); markTab('tab-student', 'home'); }
    else { tab('parent'); markTab('tab-parent', 'parent'); }
  }
  function markTab(barId, v) {
    document.querySelectorAll('#' + barId + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  }

  /* ---------------- 首页 ---------------- */
  function renderHome() {
    const rate = S.independentRate();
    const rateTxt = rate == null ? '—' : Math.round(rate * 100) + '%';
    const resume = S.getResume();
    const due = S.dueReviews();

    let resumeHtml = '';
    if (resume) {
      const p = D.problemById(resume.problemId);
      if (p) resumeHtml =
        '<div class="sec-title">继续上次</div>' +
        '<div class="qcard" onclick="QisiApp.resume()"><div class="badge">📐</div>' +
        '<div><div class="t">' + esc(p.title) + '</div><div class="d">上次进行到第 ' + (resume.stepIndex + 1) + ' 步，点我继续</div></div></div>';
    }

    // 今日待复习（遗忘曲线驱动）—— 点开服务一道「同类变式题」
    let revHtml = '<div class="sec-title">今日待复习 · 遗忘曲线</div>';
    if (due.length) {
      revHtml += due.map(r => {
        const due_lbl = r.overdueDays > 0 ? '已逾期 ' + r.overdueDays + ' 天' : '今天到期';
        const color = r.tier === '薄弱' ? 'var(--orange)' : r.tier === '一般' ? 'var(--amber)' : 'var(--ok)';
        return '<div class="qcard" onclick="QisiApp.practiceKnowledge(\'' + r.id + '\')"><div class="badge">🔁</div>' +
          '<div><div class="t">' + esc(r.name) + '</div><div class="d">' + due_lbl +
          ' · 掌握度 <b style="color:' + color + '">' + r.tier + '</b> · 点我练一道<b>变式题</b></div></div></div>';
      }).join('');
    } else if (S.totalGuided() > 0) {
      const nx = S.nextReview();
      revHtml += '<div class="empty" style="padding:18px">✅ 今天没有到期的复习啦~' +
        (nx ? '<br>下一次复习：<b>' + esc(nx.name) + '</b>（约 ' + nx.inDays + ' 天后）' : '') + '</div>';
    } else {
      revHtml = '';
    }

    $('view-home').innerHTML =
      '<div class="hero"><h2>晚上好，朵朵 👋</h2>' +
      '<p>遇到不会的题别急着抄答案——拍下来，我陪你一步步想出来。</p>' +
      '<button class="shoot" onclick="QisiApp.gotoShoot()">📷 拍题求助</button></div>' +
      '<div class="cardrow">' +
      '<div class="mini"><div class="n">' + rateTxt + '</div><div class="l">本周独立做出率</div></div>' +
      '<div class="mini"><div class="n">' + due.length + '</div><div class="l">今日待复习</div></div></div>' +
      resumeHtml + revHtml +
      (resumeHtml || revHtml ? '' : '<div class="empty"><span class="big">📷</span>还没有学习记录，点上面「拍题求助」开始第一道题吧！</div>');
  }
  function gotoShoot() { markTab('tab-student', 'shoot'); tab('shoot'); }

  /* ---------------- 拍题 / 模拟 OCR ---------------- */
  function renderShoot() {
    suspectShown = false;
    const samples = D.PROBLEMS.map(p =>
      '<div class="qcard" onclick="QisiApp.pickSample(\'' + p.id + '\')"><div class="badge">📄</div>' +
      '<div><div class="t">' + esc(p.title) + '</div><div class="d">' + esc(p.tags.join(' · ')) + ' · ' + p.difficulty + '</div></div></div>'
    ).join('');
    $('view-shoot').innerHTML =
      '<div class="cam"><div class="frame"></div><div class="ico">📷</div><div class="tip">把<b>一道题</b>放进取景框</div></div>' +
      '<div class="cambtns">' +
      '<button class="btn-primary" onclick="QisiApp.fakeShoot()">📸 拍照识别</button>' +
      '<button class="btn-ghost" onclick="document.getElementById(\'file\').click()">🖼️ 相册上传</button></div>' +
      '<input id="file" type="file" accept="image/*" capture="environment" style="display:none" onchange="QisiApp.onFile(event)">' +
      '<div class="sec-title">或选择一道示例题（模拟拍照识别）</div>' +
      '<div class="samples">' + samples + '</div>' +
      '<div class="empty" style="padding:14px 8px">📌 本期为<b>模拟识题</b>：上传任意图片或选示例题，系统会返回一道结构化题目供你确认。</div>';
  }
  function onFile(e) {
    if (!e.target.files || !e.target.files[0]) return;
    fakeShoot();
  }
  function fakeShoot() { runOCR(D.PROBLEMS[0].id, true); }     // 拍照默认主推题
  function pickSample(id) { runOCR(id, false); }

  function runOCR(problemId, maybeSuspect) {
    S.track('shoot_click');
    $('view-shoot').innerHTML = '<div class="loading"><div class="spinner"></div>正在识别题目…</div>';
    setTimeout(() => {
      const p = D.problemById(problemId);
      // 模拟极小概率「识别失败」以展示异常处理（这里固定成功，失败由专门入口演示）
      const t0 = Date.now();
      S.track('ocr_success', { problemId: p.id, knowledgeId: p.knowledgeId, durationMs: 900 });
      pendingProblem = p;
      suspectShown = maybeSuspect && Math.random() < 0.5;
      renderConfirm(p);
    }, 900);
  }
  function renderConfirm(p) {
    // 低置信度示例：把题干里的数字标红存疑（PRD 6.1.3）
    let stem = esc(p.stem);
    let suspectTip = '';
    if (suspectShown) {
      stem = stem.replace('24', '<span class="suspect">24</span>');
      suspectTip = '<div style="font-size:11px;color:var(--red);margin-bottom:8px">⚠️ 标红处识别置信度较低，请核对是否正确</div>';
    }
    $('view-shoot').innerHTML =
      '<div class="confirm">' +
      '<div class="lab">识别结果 · 请确认</div>' +
      '<div class="stem">' + stem + '</div>' +
      '<div class="formula">' + esc(p.display) + '</div>' +
      suspectTip +
      '<div class="lab">知识点标签</div>' +
      '<div class="tagrow">' + p.tags.map(t => '<span class="ktag">' + esc(t) + '</span>').join('') + '</div>' +
      '</div>' +
      '<div class="confirm-q">识别对了吗？</div>' +
      '<div class="cambtns">' +
      '<button class="btn-primary" onclick="QisiApp.confirmOCR()">✅ 没问题，开始引导</button>' +
      '<button class="btn-ghost" onclick="QisiApp.renderShoot()">🔄 重拍 / 换一题</button></div>' +
      '<button class="report-btn" style="background:#fff;color:#c0392b;border:1px solid #f0c7c0;margin-top:6px" onclick="QisiApp.simFail()">😕 模拟「没看清」(异常处理)</button>';
  }
  function simFail() {
    S.track('ocr_fail', { reason: 'blurry' });
    $('view-shoot').innerHTML =
      '<div class="empty"><span class="big">😕</span>没看清，换个角度再拍一张？<br>也可以从相册重新上传，或手动输入题干。</div>' +
      '<div class="cambtns"><button class="btn-primary" onclick="QisiApp.renderShoot()">重拍</button>' +
      '<button class="btn-ghost" onclick="QisiApp.renderShoot()">相册</button></div>';
  }
  function confirmOCR() {
    if (!pendingProblem) return;
    S.track('ocr_confirm', { problemId: pendingProblem.id, knowledgeId: pendingProblem.knowledgeId });
    openChat(pendingProblem, null);
  }

  /* ---------------- 引导对话 ---------------- */
  function openChat(problem, restore) {
    session = E.createSession(problem, restore);
    $('view-chat').classList.add('on');
    $('chat-title').textContent = problem.title;
    $('qbar').innerHTML = '📐 <b>题目</b>：' + esc(problem.stem);
    $('chat-title').textContent = problem.title + (llmActive() ? ' · AI 模式' : '');
    $('msgs').innerHTML = '';
    if (!restore) addPhotoBubble();
    dispatch(E.start(session));
  }
  function llmActive() { return !!(window.QisiLLM && QisiLLM.enabled && QisiLLM.enabled()); }

  // 统一调度：兼容脚本（同步结果）与 LLM（Promise 结果）。LLM 期间显示「正在思考…」。
  function dispatch(res) {
    const thinking = addThinking();
    Promise.resolve(res).then(out => {
      removeThinking(thinking);
      typeOut((out && out.messages) || [], () => { renderInput(out || { chips: [], done: false }); persistResume(); });
    }).catch(err => {
      removeThinking(thinking);
      if (window.console) console.error('engine error', err);
      typeOut([{ cls: '', text: '⚠️ AI 连接出错：' + esc(err && err.message ? err.message : String(err)) + '。可重试，或到「我的 → AI 内核」切回脚本模式。' }],
        () => renderInput({ messages: [], chips: [], done: false }));
    });
  }
  function addThinking() {
    const r = document.createElement('div'); r.className = 'row ai typing';
    r.innerHTML = '<div class="av">启</div><div class="bub">正在思考…</div>';
    $('msgs').appendChild(r); scrollDown(); return r;
  }
  function removeThinking(r) { if (r && r.parentNode) r.remove(); }
  function resume() {
    const r = S.getResume();
    if (!r) return;
    const p = D.problemById(r.problemId);
    if (p) { markTab('tab-student', 'home'); openChat(p, r); }
  }
  // 复习时服务一道「同类变式题」：同知识点、尽量不重复上次那道
  function practiceKnowledge(kid) {
    const probs = D.PROBLEMS.filter(x => x.knowledgeId === kid);
    const solved = S.events().filter(e => e.type === 'guide_solved' && e.knowledgeId === kid);
    const lastId = solved.length ? solved[solved.length - 1].problemId : null;
    const p = probs.find(x => x.id !== lastId) || probs[0] || D.PROBLEMS[0];
    S.track('review_start', { knowledgeId: kid, problemId: p.id });
    openChat(p, null);
  }
  function closeChat() { $('view-chat').classList.remove('on'); session = null; }
  function backFromChat() {
    if (session && session.status === 'active') persistResume();
    closeChat();
    if (role === 'student') { markTab('tab-student', 'home'); tab('home'); }
  }
  function persistResume() {
    if (session && session.status === 'active') S.setResume(E.snapshot(session));
  }

  function addPhotoBubble() {
    const row = document.createElement('div'); row.className = 'row me';
    row.innerHTML = '<div class="bub photo-bub"><div class="ph">📷 题目照片</div></div>';
    $('msgs').appendChild(row); scrollDown();
  }
  function meSay(t) {
    const row = document.createElement('div'); row.className = 'row me';
    row.innerHTML = '<div class="bub">' + esc(t) + '</div>';
    $('msgs').appendChild(row); scrollDown();
  }
  // 逐条带「正在思考」打字效果输出 AI 消息
  function typeOut(messages, done) {
    let i = 0;
    function next() {
      if (i >= messages.length) { if (done) done(); return; }
      const m = messages[i++];
      const typing = document.createElement('div'); typing.className = 'row ai typing';
      typing.innerHTML = '<div class="av">启</div><div class="bub">正在思考…</div>';
      $('msgs').appendChild(typing); scrollDown();
      setTimeout(() => {
        typing.remove();
        const row = document.createElement('div'); row.className = 'row ai';
        row.innerHTML = '<div class="av">启</div><div class="bub ' + (m.cls || '') + '">' + m.text + '</div>';
        $('msgs').appendChild(row); scrollDown();
        setTimeout(next, 250);
      }, 650);
    }
    next();
  }

  function renderInput(out) {
    const bar = $('inputbar');
    if (out.done) {
      bar.innerHTML = '<div class="chips">' +
        (out.chips || []).map(c => '<button class="chip" onclick="QisiApp.terminalChip(\'' + encodeURIComponent(c) + '\')">' + esc(c) + '</button>').join('') +
        '</div>';
      persistResumeClearIfDone();
      return;
    }
    // 「看完整解答」二选项
    if (out.offerFull) {
      bar.innerHTML = '<div class="chips">' +
        '<button class="chip hintbtn" onclick="QisiApp.giveFull()">看完整解答</button>' +
        '<button class="chip" onclick="QisiApp.continueThink()">我再想想</button></div>';
      return;
    }
    const chips = (out.chips || []).map(c =>
      '<button class="chip" onclick="QisiApp.choose(\'' + encodeURIComponent(c) + '\')">' + esc(c) + '</button>'
    ).join('');
    bar.innerHTML =
      '<div class="hintchip-row"><button onclick="QisiApp.hint()">💡 我想要提示（第 ' + (session.hintLevel + 1 <= 4 ? '①②③④'[session.hintLevel] : '④') + ' 档）</button></div>' +
      '<div class="chips">' + chips + '</div>' +
      '<div class="typerow"><input id="answer" placeholder="也可以直接输入答案…" ' +
      'onkeydown="if(event.key===\'Enter\')QisiApp.sendInput()"><button class="send" onclick="QisiApp.sendInput()">发送</button></div>';
  }
  function persistResumeClearIfDone() { if (session && session.status !== 'active') S.clearResume(); }

  function choose(enc) { handleAnswer(decodeURIComponent(enc)); }
  function sendInput() {
    const el = $('answer'); if (!el) return;
    const v = el.value.trim(); if (!v) return;
    handleAnswer(v);
  }
  function handleAnswer(text) {
    if (!session) return;
    meSay(text);
    $('inputbar').innerHTML = '';
    dispatch(E.submit(session, text));
  }
  function hint() {
    if (!session) return;
    meSay('💡 我想要提示');
    $('inputbar').innerHTML = '';
    dispatch(E.requestHint(session));
  }
  function giveFull() {
    $('inputbar').innerHTML = '';
    dispatch(E.giveFull(session));
  }
  function continueThink() {
    const step = session.problem.steps[session.stepIndex];
    renderInput({ chips: step.chips, done: false });
  }
  function terminalChip(enc) {
    const c = decodeURIComponent(enc);
    if (c.indexOf('再做') >= 0) { closeChat(); gotoShoot(); }
    else if (c.indexOf('错题本') >= 0) { closeChat(); markTab('tab-student', 'book'); tab('book'); }
  }

  /* ---------------- 错题本 + 知识图谱 ---------------- */
  function renderBook() {
    const wb = S.wrongbook();
    // 按知识点分组
    const groups = {};
    wb.forEach(w => { (groups[w.knowledgeId] = groups[w.knowledgeId] || []).push(w); });
    let wbHtml;
    if (!wb.length) {
      wbHtml = '<div class="empty"><span class="big">🎉</span>错题本是空的，独立做出的题不会进来。<br>用到高档提示或没做出来的题才会自动收录。</div>';
    } else {
      wbHtml = Object.keys(groups).map(kid => {
        const m = S.masteryFor(kid);
        const cls = m.tier === '牢固' ? 'ok' : m.tier === '一般' ? 'amber' : 'weak';
        const color = m.tier === '牢固' ? 'var(--ok)' : m.tier === '一般' ? 'var(--amber)' : 'var(--orange)';
        const icon = m.tier === '薄弱' ? '✕' : m.tier === '一般' ? '!' : '✓';
        const bg = m.tier === '薄弱' ? '#fde8e8;color:#c0392b' : m.tier === '一般' ? '#fff3e0;color:#e67e22' : '#e8f5e9;color:#16a34a';
        const p = D.problemById(groups[kid][0].problemId);
        return '<div class="qcard" onclick="QisiApp.practiceKnowledge(\'' + kid + '\')">' +
          '<div class="badge" style="background:' + bg + '">' + icon + '</div>' +
          '<div><div class="t">' + esc(D.knowledgeName(kid)) + '</div>' +
          '<div class="d">' + groups[kid].length + ' 道 · 掌握度 <b style="color:' + color + '">' + m.tier + '</b> · 点我再练一道</div></div></div>';
      }).join('');
    }

    // 知识图谱
    const ml = D.KNOWLEDGE.map(k => Object.assign({ name: k.name }, S.masteryFor(k.id))).filter(m => m.attempts > 0);
    let mapHtml;
    if (!ml.length) {
      mapHtml = '<div class="empty" style="padding:16px">练几道题后，这里会显示你各知识点的掌握进度。</div>';
    } else {
      mapHtml = '<div class="pcard" style="margin-bottom:0">' + ml.sort((a, b) => b.score - a.score).map(m => {
        const fillCls = m.tier === '牢固' ? '' : m.tier === '一般' ? 'amber' : 'weak';
        const tierCls = m.tier === '牢固' ? 'tier-green' : m.tier === '一般' ? 'tier-amber' : 'tier-weak';
        return '<div class="barline"><div class="lab"><span>' + esc(m.name) + '</span>' +
          '<span class="' + tierCls + '">' + m.tier + '</span></div>' +
          '<div class="track"><div class="fill ' + fillCls + '" style="width:' + m.score + '%"></div></div></div>';
      }).join('') + '</div>';
    }

    $('view-book').innerHTML =
      '<div class="sec-title">错题本 · 按知识点</div>' + wbHtml +
      '<div class="sec-title" style="margin-top:14px">知识点掌握图谱</div>' + mapHtml;
  }

  /* ---------------- 我的 ---------------- */
  function renderMe() {
    const total = S.totalGuided();
    const avg = S.avgHintLevel();
    const avgTxt = avg == null ? '—' : avg.toFixed(1);
    const streak = S.streakDays();
    $('view-me').innerHTML =
      '<div class="pcard" style="text-align:center"><div class="avatar">朵</div>' +
      '<h3>朵朵 · 初二</h3><div class="week">连续学习 ' + streak + ' 天 🔥</div></div>' +
      '<div class="cardrow">' +
      '<div class="mini"><div class="n">' + total + '</div><div class="l">累计引导题数</div></div>' +
      '<div class="mini"><div class="n">' + avgTxt + '</div><div class="l">平均提示档/题</div></div></div>' +
      '<div class="advice">' + meAdvice(avg, total) + '</div>' +
      '<div class="linkrow" onclick="QisiApp.openDrawer()"><span>📊 查看埋点事件流</span><span class="r">PRD 第 9 章 ›</span></div>' +
      '<div class="linkrow" onclick="QisiApp.openLLM()"><span>🤖 AI 内核</span><span class="r">' + llmStatusLabel() + '</span></div>' +
      '<div class="linkrow" onclick="QisiApp.fastForward()"><span>⏩ 模拟过一天</span><span class="r">' +
        (S.timeOffsetDays() > 0 ? '已快进 ' + S.timeOffsetDays() + ' 天 · ' : '') + '演示遗忘曲线 ›</span></div>' +
      '<div class="linkrow" onclick="QisiApp.resetAll()" style="color:#c0392b"><span>♻️ 重置体验数据</span><span class="r">清空本地记录 ›</span></div>';
  }
  function fastForward() {
    S.fastForwardDays(1);
    renderMe();
    toast('已模拟过 1 天 ⏩ 回首页看「今日待复习」会有变化');
  }
  function meAdvice(avg, total) {
    if (!total) return '还没有学习记录哦，去拍一道题，我陪你想出来 💪';
    if (avg != null && avg < 1.5) return '你越来越少看提示啦——平均每题只用 <b>' + avg.toFixed(1) + '</b> 档提示，正在越来越独立地解题 💪';
    return '已经累计独立挑战 <b>' + total + '</b> 道题啦，遇到卡壳记得先想一步再看提示，进步会更快 ✨';
  }

  /* ---------------- 家长周报 ---------------- */
  function renderParent() {
    const wb = S.wrongbook();
    $('view-parent').innerHTML =
      '<button class="report-btn" onclick="QisiApp.genReport()">📊 生成本周学情周报</button>' +
      '<div id="report-body"><div class="empty"><span class="big">📩</span>点上方按钮，根据孩子本周真实学习数据生成周报。<br>（数据来自引导对话的埋点聚合）</div></div>';
  }
  function genReport() {
    S.track('report_push');
    S.track('report_open');
    const r = S.buildReport();
    S.snapshotReport(r);
    const body = $('report-body');

    if (!r.enough) {
      body.innerHTML =
        '<div class="pcard"><h3>📊 朵朵的本周学情周报</h3><div class="week">' + weekLabel() + ' · 数据较少友好版</div>' +
        '<div class="advice">本周引导题数较少（' + r.guidedCount + ' 道），暂不下结论。' + esc(r.advice) + '</div></div>';
      return;
    }
    const rateTxt = Math.round(r.rate * 100) + '%';
    let deltaHtml = '';
    if (r.delta != null) {
      const up = r.delta >= 0;
      deltaHtml = '<span class="up ' + (up ? '' : 'down') + '">' + (up ? '▲ ' : '▼ ') + Math.abs(Math.round(r.delta * 100)) + '%</span>';
    } else {
      deltaHtml = '<span class="up" style="color:#9aa3b2;font-weight:600">首期</span>';
    }
    const weakBars = r.weak.map(w => {
      const fillCls = w.tier === '牢固' ? '' : w.tier === '一般' ? 'amber' : 'weak';
      const tierCls = w.tier === '牢固' ? 'tier-green' : w.tier === '一般' ? 'tier-amber' : 'tier-weak';
      return '<div class="barline"><div class="lab"><span>' + esc(w.name) + '</span>' +
        '<span class="' + tierCls + '">' + w.tier + '</span></div>' +
        '<div class="track"><div class="fill ' + fillCls + '" style="width:' + w.score + '%"></div></div></div>';
    }).join('');
    const habitPct = r.avgHint == null ? 0 : Math.round(r.avgHint / 4 * 100);
    const habitTrend = r.hintDelta == null ? '本期建立基线'
      : r.hintDelta < -0.03 ? '下降中 ▼（更独立）' : r.hintDelta > 0.03 ? '略升 ▲' : '基本持平';

    body.innerHTML =
      '<div class="pcard"><h3>📊 朵朵的本周学情周报</h3><div class="week">' + weekLabel() + '</div>' +
      '<div class="bignum"><span class="v">' + rateTxt + '</span>' + deltaHtml + '</div>' +
      '<div style="font-size:12px;color:#6b7280">独立做出率（无需看完整答案即做对）· 本周 ' + r.guidedCount + ' 道引导题</div></div>' +
      '<div class="pcard"><h3 style="margin-bottom:10px">薄弱知识点 Top ' + r.weak.length + '</h3>' + weakBars + '</div>' +
      '<div class="pcard"><h3 style="margin-bottom:8px">学习习惯</h3>' +
      '<div class="barline"><div class="lab"><span>提示依赖度（越低越独立）</span><span class="tier-green">' + habitTrend + '</span></div>' +
      '<div class="track"><div class="fill" style="width:' + habitPct + '%"></div></div></div></div>' +
      '<div class="advice">💡 <b>给家长的建议</b>：' + esc(r.advice) + '</div>' +
      '<div class="share-row"><button onclick="QisiApp.shareReport()">📤 分享给家人</button>' +
      '<button onclick="QisiApp.genReport()">🔄 刷新</button></div>';
  }
  function shareReport() { S.track('report_share'); toast('已生成分享卡片（演示）'); }

  /* ---------------- 埋点面板 ---------------- */
  function openDrawer() { renderDrawer(); $('drawer').classList.add('on'); }
  function closeDrawer() { $('drawer').classList.remove('on'); }
  function renderDrawer() {
    const evs = S.events().slice().reverse();
    $('evlist').innerHTML = evs.length ? evs.map(e => {
      const p = Object.assign({}, e); delete p.type; delete p.ts;
      const pstr = Object.keys(p).map(k => k + '=' + p[k]).join(' ');
      const tm = new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false });
      return '<div class="ev' + (e.type === 'leak_blocked' ? ' leak' : '') + '"><span class="t">' + e.type + '</span>' +
        '<span class="p">' + esc(pstr) + '</span><span class="tm">' + tm + '</span></div>';
    }).join('') : '<div class="empty">还没有事件，去拍一道题试试。</div>';
  }
  function onEvent() { if ($('drawer').classList.contains('on')) renderDrawer(); }

  /* ---------------- AI 内核设置（BYOK） ---------------- */
  function llmCfg() { return (window.QisiLLM && QisiLLM.getConfig) ? QisiLLM.getConfig() : { mode: 'script', key: '', model: '' }; }
  function llmStatusLabel() { return llmCfg().mode === 'ai' ? 'AI 模式 · Claude ›' : '规则脚本 ›'; }

  function openLLM() {
    if (!window.QisiLLM || !QisiLLM.getConfig) { toast('AI 适配器未加载'); return; }
    renderLLMBody();
    $('llm-drawer').classList.add('on');
  }
  function closeLLM() { $('llm-drawer').classList.remove('on'); }
  function renderLLMBody() {
    const c = llmCfg();
    $('llm-body').innerHTML =
      '<div class="sec-title" style="margin:0 0 8px">内核模式</div>' +
      '<label class="llm-opt"><input type="radio" name="llmmode" value="script" ' + (c.mode !== 'ai' ? 'checked' : '') + '>' +
      '<span><b>规则脚本</b>（默认）<br><i>离线 · 稳定 · 免费；只能引导题库内的题</i></span></label>' +
      '<label class="llm-opt"><input type="radio" name="llmmode" value="ai" ' + (c.mode === 'ai' ? 'checked' : '') + '>' +
      '<span><b>AI 模式（Claude）</b><br><i>用你自己的 Anthropic Key 直连模型，可引导任意题</i></span></label>' +
      '<div class="sec-title" style="margin:8px 0 6px">Anthropic API Key</div>' +
      '<input id="llm-key" type="password" placeholder="sk-ant-..." value="' + esc(c.key || '') + '" class="llm-input">' +
      '<div class="sec-title" style="margin:10px 0 6px">模型</div>' +
      '<input id="llm-model" type="text" value="' + esc(c.model || 'claude-sonnet-4-6') + '" class="llm-input">' +
      '<div class="llm-note">🔒 Key 仅存在你<b>浏览器本地</b>(localStorage)，不上传、不进 Git 仓库。浏览器直连 Anthropic 需联网，Key 在前端可见——仅建议用于本地体验 / Demo；生产环境应走后端代理（见 README）。</div>' +
      '<button class="report-btn" onclick="QisiApp.saveLLM()">保存</button>' +
      '<button class="report-btn" style="background:#fff;color:var(--blue);border:1px solid #cdd6e6" onclick="QisiApp.closeLLM()">取消</button>';
  }
  function saveLLM() {
    const mode = (document.querySelector('input[name=llmmode]:checked') || {}).value || 'script';
    const key = ($('llm-key').value || '').trim();
    const model = ($('llm-model').value || '').trim() || 'claude-sonnet-4-6';
    if (mode === 'ai' && !key) { toast('AI 模式需要填入 API Key'); return; }
    QisiLLM.setConfig({ mode: mode, key: key, model: model });
    closeLLM(); renderMe();
    toast(mode === 'ai' ? '已启用 AI 模式（Claude） · 下一道题生效' : '已切回规则脚本');
  }

  /* ---------------- 杂项 ---------------- */
  function resetAll() {
    if (!confirm('确定清空本地体验数据？错题本、掌握度、周报都会重置。')) return;
    S.reset(); toast('已重置'); renderMe();
  }
  function toast(t) {
    const d = document.createElement('div');
    d.textContent = t;
    d.style.cssText = 'position:absolute;left:50%;bottom:90px;transform:translateX(-50%);background:rgba(17,21,28,.9);color:#fff;font-size:12px;padding:9px 14px;border-radius:10px;z-index:60;max-width:280px;text-align:center;line-height:1.5';
    $('screen').appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }
  function weekLabel() {
    const now = new Date();
    const d2 = (n) => (n < 10 ? '0' : '') + n;
    const start = new Date(now.getTime() - 6 * 864e5);
    return (start.getMonth() + 1) + '月' + start.getDate() + '日 – ' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
  }
  function scrollDown() { const m = $('msgs'); if (m) m.scrollTop = m.scrollHeight; }

  /* ---------------- 导出 ---------------- */
  global.QisiApp = {
    tab, setRole, gotoShoot, renderShoot,
    fakeShoot, onFile, pickSample, simFail, confirmOCR,
    resume, practiceKnowledge, backFromChat,
    choose, sendInput, hint, giveFull, continueThink, terminalChip,
    genReport, shareReport,
    openDrawer, closeDrawer, onEvent, resetAll,
    openLLM, closeLLM, saveLLM, fastForward
  };

  document.addEventListener('DOMContentLoaded', () => { setRole('student'); });
})(window);
