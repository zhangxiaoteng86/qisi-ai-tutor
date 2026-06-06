/* ==========================================================================
 * 启思 AI 家教 — 苏格拉底引导引擎  (engine.js)
 * --------------------------------------------------------------------------
 * 实现 PRD 6.2 对话状态机 + 6.2.3 提示阶梯 + 6.2.4 判定 + 7.3 后置校验。
 *
 * 【可替换为 LLM】每轮决策走 decide()。当 QisiLLM.guideTurn 存在时，引擎会
 * 把当前 state + 学生输入交给它产出下一句引导；否则用脚本规则（本期默认）。
 * 无论哪种来源，AI 的每条草稿都会过 antiLeak() 后置校验后才下发（防泄题）。
 * ======================================================================== */
(function (global) {
  'use strict';

  const HINT_LABELS = ['', '第 ① 档 · 方向点拨', '第 ② 档 · 关键知识点', '第 ③ 档 · 下一步怎么走', '第 ④ 档 · 完整解答'];

  /* ---------- 答案判定：等价归一（PRD 6.2.4） ---------- */
  function normalize(s) {
    if (s == null) return '';
    return String(s)
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[，、和]/g, ',')
      .replace(/[（）]/g, m => (m === '（' ? '(' : ')'))
      .replace(/[×∗·＊]/g, '*')
      .replace(/[÷／]/g, '/')
      .replace(/[－–—−]/g, '-')
      .replace(/[＋]/g, '+')
      .replace(/[＝]/g, '=')
      .replace(/[＾]/g, '^')
      .replace(/²/g, '^2')
      .replace(/x2/g, 'x^2')        // x2 视作 x^2（仅在含 x 的式子里安全够用）
      .replace(/米|平方米|m2|m²|个|元/g, '')
      .replace(/^答案是|^答案|^得|^解得|^所以/g, '');
  }
  // 纯数值等价（如 "x=4" 与 "4"）
  function numEquiv(a, b) {
    const na = parseFloat(String(a).replace(/[^0-9.\-]/g, ''));
    const nb = parseFloat(String(b).replace(/[^0-9.\-]/g, ''));
    if (isNaN(na) || isNaN(nb)) return false;
    return Math.abs(na - nb) < 1e-6;
  }
  function judge(input, accept) {
    const ni = normalize(input);
    if (!ni) return false;
    for (const a of accept) {
      const na = normalize(a);
      if (ni === na) return true;
      if (ni.replace(/^x=/, '') === na.replace(/^x=/, '')) return true; // 容忍前缀 x=
      if (/^[0-9.\-]+$/.test(na.replace(/^x=/, '')) && numEquiv(ni, na)) return true;
    }
    return false;
  }

  /* ---------- 后置校验：防泄题（PRD 7.3） ----------
   * 当 hintLevel < 4 时，扫描 AI 草稿是否包含「最终答案 / 可照抄结论」。
   * 命中则判为疑似泄题 → 调用方应重生成或降级（脚本引擎天然不泄题，这里作为
   * 真实存在的校验闸门，命中即记 leak_blocked）。
   */
  function antiLeak(draft, problem, hintLevel) {
    if (hintLevel >= 4) return { ok: true };
    const text = normalize(draft);
    // 题目最终答案的归一形式
    const finalStep = problem.steps[problem.steps.length - 1];
    const leakSignals = (finalStep.accept || []).map(normalize).filter(a => /^[0-9]/.test(a.replace(/^x=/, '')) || a.length <= 6);
    for (const sig of leakSignals) {
      if (sig && text.indexOf(sig) >= 0 && draftLooksLikeAnswer(draft)) {
        return { ok: false, reason: '草稿疑似包含最终答案' };
      }
    }
    return { ok: true };
  }
  function draftLooksLikeAnswer(draft) {
    return /答案|等于|就是|=\s*[0-9]/.test(draft);
  }

  /* ---------- 会话 ---------- */
  function createSession(problem, restore) {
    const s = {
      problem: problem,
      stepIndex: restore ? restore.stepIndex : 0,
      hintLevel: restore ? restore.hintLevel : 0,
      wrongStreak: restore ? restore.wrongStreak : 0,
      status: restore ? restore.status : 'active',   // active | solved | given | giveup
      turns: restore ? restore.turns : 0,
      usedHintEver: restore ? restore.usedHintEver : false,
      maxWrongStreak: restore ? restore.maxWrongStreak : 0,
      demandCount: restore ? restore.demandCount : 0,
      leakBlocked: restore ? restore.leakBlocked : 0
    };
    return s;
  }

  // 快照（用于「继续上次」）
  function snapshot(s) {
    return {
      problemId: s.problem.id, stepIndex: s.stepIndex, hintLevel: s.hintLevel,
      wrongStreak: s.wrongStreak, status: s.status, turns: s.turns,
      usedHintEver: s.usedHintEver, maxWrongStreak: s.maxWrongStreak,
      demandCount: s.demandCount, leakBlocked: s.leakBlocked
    };
  }

  /* ---------- AI 消息构造 ----------
   * 脚本引擎的话术是教研预先审过的「可信内容」，不过后置校验（否则像
   * 「对应的就是 2 和 3」这类合法提示会被误伤）。后置校验只作用于
   * 「不可信」的 LLM 草稿——见 finalizeLLM / aiMsgChecked（对齐 PRD 7.3：
   * 校验的是模型每次回复）。
   */
  function aiMsg(s, text, cls) {
    return { role: 'ai', cls: cls || '', text: text };
  }
  // 仅用于 LLM 草稿：过后置校验，命中泄题则降级为安全话术并记 leak_blocked。
  // guard=false 时跳过校验（终局确认时学生已做对，复述答案是合法的）。
  function aiMsgChecked(s, text, cls, guard) {
    if (guard) {
      const check = antiLeak(text, s.problem, s.hintLevel);
      if (!check.ok) {
        s.leakBlocked++;
        QisiStore.track('leak_blocked', { problemId: s.problem.id, reason: check.reason });
        text = '我们一步步来，先想想这一步该怎么做？';
      }
    }
    return { role: 'ai', cls: cls || '', text: text };
  }

  function currentStep(s) { return s.problem.steps[s.stepIndex]; }

  // 是否启用真实 LLM 内核（BYOK）。未启用则全部走脚本，行为与之前完全一致。
  function llmOn() {
    return !!(global.QisiLLM && global.QisiLLM.enabled && global.QisiLLM.enabled());
  }

  /* ---------- 开场 ---------- */
  // 返回结果对象，或（LLM 模式下）返回 Promise<结果对象>。调用方用 Promise.resolve 兼容两者。
  function start(s) {
    QisiStore.track('guide_start', { problemId: s.problem.id, knowledgeId: s.problem.knowledgeId });
    if (llmOn()) {
      return Promise.resolve(global.QisiLLM.start(s.problem))
        .then(o => finalizeLLM(s, o, { kind: 'start' }))
        .catch(() => scriptedStart(s));   // LLM 开场失败 → 回退脚本开场（全新会话，安全）
    }
    return scriptedStart(s);
  }
  function scriptedStart(s) {
    const step = currentStep(s);
    return { messages: [aiMsg(s, step.ask)], chips: step.chips, done: false };
  }

  /* ---------- 学生作答（核心决策） ---------- */
  function submit(s, input) {
    if (s.status !== 'active') return { messages: [], chips: [], done: true };
    s.turns++;

    // LLM 模式：整轮交给模型，引擎只做后置校验 + 埋点 + 终局落库（错误向上抛给 UI 兜底）
    if (llmOn()) {
      return Promise.resolve(global.QisiLLM.turn(input))
        .then(o => finalizeLLM(s, o, { kind: 'answer' }));
    }

    // ↓↓↓ 以下为脚本规则引擎（默认） ↓↓↓
    // 0) 特殊意图：要求直接给答案（PRD 6.2.5）
    if (isDemandAnswer(input)) return handleDemand(s);
    // 跑题/闲聊
    if (isOffTopic(input)) {
      return {
        messages: [aiMsg(s, '我们先把这道题搞定，好不好？回到刚才的问题：' + stripBold(currentStep(s).ask))],
        chips: currentStep(s).chips, done: false
      };
    }
    // 放弃
    if (isGiveUp(input)) return handleGiveUpIntent(s);

    // 2) 脚本规则决策
    const step = currentStep(s);
    const correct = judge(input, step.accept);
    QisiStore.track('guide_turn', { problemId: s.problem.id, stepIndex: s.stepIndex, correct: correct });

    if (correct) {
      s.wrongStreak = 0;
      const msgs = [aiMsg(s, step.praise || '答对了！', 'praise')];
      s.stepIndex++;
      if (s.stepIndex >= s.problem.steps.length) {
        return finishSolved(s, msgs);                // 终局：独立做出 / 用过提示做出
      }
      msgs.push(aiMsg(s, currentStep(s).ask));
      return { messages: msgs, chips: currentStep(s).chips, done: false };
    }

    // 答错：先肯定再纠正，不给答案
    s.wrongStreak++;
    s.maxWrongStreak = Math.max(s.maxWrongStreak, s.wrongStreak);

    // 连续答错≥3：主动提议看提示并自动升一档（PRD 6.2.5）
    if (s.wrongStreak >= 3 && s.hintLevel < 4) {
      const bumped = bumpHint(s);
      return {
        messages: [
          aiMsg(s, '没关系，这一步确实有点绕。我们看个提示一起过这关 👇'),
          aiMsg(s, hintText(s, bumped), 'hint')
        ],
        chips: stepChipsWithHint(s), done: false
      };
    }

    return {
      messages: [aiMsg(s, encourage() + step.onWrong)],
      chips: stepChipsWithHint(s), done: false
    };
  }

  /* ---------- 求助提示（严格不跳档，PRD 6.2.3） ---------- */
  function requestHint(s) {
    if (s.status !== 'active') return { messages: [], chips: [], done: true };

    // LLM 模式：把「请求提示」作为一轮发给模型，要求只升一档、不跳档、不泄题
    if (llmOn()) {
      return Promise.resolve(global.QisiLLM.turn(
        '[学生请求提示] 请只在当前基础上提升一档提示（不可跳档、不可直接给最终答案），并返回更新后的 hintLevel。'
      )).then(o => finalizeLLM(s, o, { kind: 'hint' }));
    }

    if (s.hintLevel >= 4) {
      // 已到第④档：直接进入「已给答案」终局
      return finishGiven(s, [aiMsg(s, '完整解答前面已经给过啦，照着再写一遍会记得更牢～', 'hint')]);
    }
    const lvl = bumpHint(s);
    if (lvl === 4) {
      // 第④档 = 完整解答 → 终局（已给答案）
      return finishGiven(s, [
        aiMsg(s, '<span class="hl">' + HINT_LABELS[4] + '</span>' + s.problem.fullSolution, 'hint')
      ]);
    }
    return {
      messages: [aiMsg(s, hintText(s, lvl), 'hint')],
      chips: stepChipsWithHint(s), done: false
    };
  }
  function bumpHint(s) {
    s.hintLevel = Math.min(4, s.hintLevel + 1);
    s.usedHintEver = true;
    QisiStore.track('hint_request', { problemId: s.problem.id, hintLevel: s.hintLevel });
    return s.hintLevel;
  }
  function hintText(s, lvl) {
    const step = currentStep(s);
    const map = { 1: step.hints.dir, 2: step.hints.know, 3: step.hints.next };
    return '<span class="hl">' + HINT_LABELS[lvl] + '</span>' + (map[lvl] || '');
  }

  /* ---------- 终局 ---------- */
  function finishSolved(s, leadMsgs) {
    const independent = s.hintLevel < 4 && !(s.hintLevel >= 3); // 独立=未到④档（用③档算辅助但仍算独立做出，按 PRD：未看④档即独立）
    const trulyIndependent = s.hintLevel < 4;
    s.status = 'solved';
    const msgs = leadMsgs.slice();
    if (trulyIndependent) {
      msgs.push(aiMsg(s,
        '太棒了！这道题你<b>自己想出来了</b> 🎉<br>用到的方法是：<b>' + s.problem.methodRecap + '</b>。' +
        (s.usedHintEver ? '（用了 ' + s.hintLevel + ' 档提示，下次试试更少 💪）' : '（全程没看提示，厉害！）'),
        'praise'));
    } else {
      msgs.push(aiMsg(s, '你跟着完整解答把它做出来了。<b>' + s.problem.methodRecap + '</b>，照着再独立写一遍会更牢。', 'praise'));
    }
    recordTerminal(s, trulyIndependent);
    return { messages: msgs, chips: ['🔄 再做一道', '📒 查看错题本'], done: true, terminal: 'solved', independent: trulyIndependent };
  }

  function finishGiven(s, leadMsgs) {
    s.status = 'given';
    const msgs = leadMsgs.slice();
    msgs.push(aiMsg(s, '这道题这次算「<b>看了答案</b>」，已帮你收进错题本。建议照着步骤<b>自己再写一遍</b>，下次就能独立拿下 💪', 'praise'));
    recordTerminal(s, false);
    return { messages: msgs, chips: ['🔄 再做一道', '📒 查看错题本'], done: true, terminal: 'given', independent: false };
  }

  function recordTerminal(s, independent) {
    QisiStore.track('guide_solved', {
      problemId: s.problem.id, knowledgeId: s.problem.knowledgeId,
      hintLevel: s.hintLevel, independent: independent
    });
    // 错题入库判定（PRD 6.3.2）
    const enterWrong = s.hintLevel >= 3 || s.maxWrongStreak >= 3 || !independent;
    if (enterWrong) {
      const m = QisiStore.masteryFor(s.problem.knowledgeId);
      QisiStore.addWrong({
        problemId: s.problem.id,
        knowledgeId: s.problem.knowledgeId,
        reason: !independent ? '未独立做出' : (s.hintLevel >= 3 ? '用到高档提示' : '连续答错'),
        masteryTagAtEntry: m.tier
      });
    } else {
      QisiStore.removeWrong(s.problem.id);   // 独立做出 → 不入错题本
    }
    QisiStore.clearResume();
  }

  /* ---------- 意图分支 ---------- */
  function handleDemand(s) {
    s.demandCount++;
    if (s.demandCount >= 2) {
      // 坚持要 → 给④档完整解答，记为已给答案
      bumpHint(s); s.hintLevel = 4;
      return finishGiven(s, [
        aiMsg(s, '好，那我把完整过程给你，但记得自己再走一遍哦：'),
        aiMsg(s, '<span class="hl">' + HINT_LABELS[4] + '</span>' + s.problem.fullSolution, 'hint')
      ]);
    }
    return {
      messages: [aiMsg(s, '我懂你想快点过 😊 不过<b>自己想出一步会记得更久</b>。要不我给你一个小提示，你再试一下？')],
      chips: stepChipsWithHint(s), done: false
    };
  }
  function handleGiveUpIntent(s) {
    if (s.hintLevel < 1) {
      bumpHint(s);
      return {
        messages: [
          aiMsg(s, '别灰心，卡住很正常～我先给你指个方向，再试一次好吗？'),
          aiMsg(s, hintText(s, 1), 'hint')
        ],
        chips: stepChipsWithHint(s), done: false
      };
    }
    // 已给过方向仍放弃 → 可直达④档
    return {
      messages: [aiMsg(s, '没关系，这次我们一起看完整解题过程，下次再独立挑战 👇')],
      chips: ['看完整解答', '我再想想'], done: false, offerFull: true
    };
  }
  function giveUp(s) {
    s.status = 'giveup';
    QisiStore.track('guide_giveup', { problemId: s.problem.id });
    QisiStore.track('guide_solved', { problemId: s.problem.id, knowledgeId: s.problem.knowledgeId, hintLevel: s.hintLevel, independent: false });
    const m = QisiStore.masteryFor(s.problem.knowledgeId);
    QisiStore.addWrong({ problemId: s.problem.id, knowledgeId: s.problem.knowledgeId, reason: '放弃未完成', masteryTagAtEntry: m.tier });
    QisiStore.clearResume();
  }

  /* ---------- LLM 决策结果整形（埋点 + 后置校验 + 终局落库） ----------
   * 契约见 assets/llm-adapter.js：{ messages:[{text,cls}], chips, hintLevel,
   * done, independent, correct }。引擎在这里统一上埋点、过防泄题、走终局。
   */
  function finalizeLLM(s, out, opts) {
    opts = opts || {};
    out = out || {};
    // 同步模型自报的提示档（严格不下降）
    if (out.hintLevel != null) {
      const lvl = Math.max(0, Math.min(4, out.hintLevel | 0));
      if (lvl > s.hintLevel) {
        for (let i = s.hintLevel; i < lvl; i++) {
          s.hintLevel = i + 1; s.usedHintEver = true;
          QisiStore.track('hint_request', { problemId: s.problem.id, hintLevel: s.hintLevel });
        }
      }
    }
    // 答题轮埋点
    if (opts.kind === 'answer' && !out.done) {
      QisiStore.track('guide_turn', { problemId: s.problem.id, stepIndex: -1, correct: out.correct === true });
    }
    // 防泄题只在「非终局」时启用（终局是学生已做对，复述答案合法）
    const guard = !out.done;
    const msgs = (out.messages || []).map(m => aiMsgChecked(s, m.text, m.cls, guard));

    if (out.done) {
      if (out.independent) return finishSolved(s, msgs);
      return finishGiven(s, msgs);
    }
    return { messages: msgs, chips: out.chips || [], done: false };
  }

  /* ---------- 工具 ---------- */
  function stepChipsWithHint(s) {
    const step = currentStep(s);
    return (step ? step.chips.slice() : []);
  }
  function stripBold(t) { return String(t).replace(/<[^>]+>/g, ''); }
  function encourage() {
    const arr = ['思路有一部分是对的，', '想法不错，', '差一点点，', '方向在靠近，'];
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function isDemandAnswer(t) { return /直接.*答案|告诉我答案|答案是多少|给我答案|别问了|直接说/.test(t); }
  function isGiveUp(t) { return /^不会$|不会了|放弃|不想做|做不出|算了/.test(t.trim()); }
  function isOffTopic(t) { return /你是谁|无聊|讲笑话|吃饭|游戏|玩/.test(t) && t.length < 12; }

  global.QisiEngine = {
    createSession, snapshot, start, submit, requestHint, giveUp,
    // 暴露给「看完整解答」按钮
    giveFull: function (s) {
      bumpHint(s); s.hintLevel = 4;
      return finishGiven(s, [aiMsg(s, '<span class="hl">' + HINT_LABELS[4] + '</span>' + s.problem.fullSolution, 'hint')]);
    },
    // 暴露判定/归一供测试
    _judge: judge, _normalize: normalize, _antiLeak: antiLeak
  };
})(window);
