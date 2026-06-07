/* ==========================================================================
 * 启思 AI 家教 — LLM 适配器（BYOK，浏览器直连 Anthropic）
 * --------------------------------------------------------------------------
 * 默认不启用：内核模式 = 规则脚本。用户在「我的 → AI 内核」切到 AI 模式并填入
 * 自己的 Anthropic API Key 后，引导对话改由 Claude 驱动（engine.js 会对模型每条
 * 回复过一遍防泄题后置校验，对齐 PRD 7.3）。
 *
 * 安全说明：Key 仅存浏览器 localStorage，不上传、不进仓库。浏览器直连需带
 * `anthropic-dangerous-direct-browser-access` 头，Key 在前端可见——仅用于本地
 * 体验 / Demo；生产应改为后端代理（把 callClaude 的 endpoint 指向你的服务端）。
 *
 * 引擎契约（见 engine.js finalizeLLM）——本适配器 start()/turn() 返回 Promise，
 * resolve 为：{ messages:[{text,cls}], chips, hintLevel, done, independent, correct }
 * ======================================================================== */
(function (global) {
  'use strict';
  const LS_KEY = 'qisi_llm_v1';

  /* ---------- 配置（localStorage） ---------- */
  function getConfig() {
    let c = { mode: 'script', key: '', model: 'claude-sonnet-4-6' };
    try { c = Object.assign(c, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (e) {}
    return c;
  }
  function setConfig(c) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(c)); } catch (e) {}
  }
  function enabled() { const c = getConfig(); return c.mode === 'ai' && !!c.key; }

  /* ---------- 系统提示词（落实 PRD 7.2 硬约束） ---------- */
  const SYSTEM = [
    '你是「启思 AI 家教」，用苏格拉底式方法引导一名初中生解一道数学题。你会先收到题目和标准解法作参考。',
    '',
    '硬性规则（必须遵守）：',
    '1. 在学生还没把提示升到第 ④ 档之前，绝对不要给出最终答案或可直接照抄的完整步骤；只给「下一步该想什么」。',
    '2. 每次只问一个问题、只推进一步，不要一次抛出整条解题链。',
    '3. 学生答对就先肯定再推进；答错先肯定其合理部分，再不给答案地换个角度追问。',
    '4. 语气贴近初中生，简洁、鼓励、不卖弄术语。不要编造知识点。',
    '5. 提示分 4 档由弱到强：① 方向 ② 关键知识点 ③ 下一步怎么走 ④ 完整解答。学生每点一次「请求提示」只升一档，不可跳档。到第 ④ 档才给完整解答，并把 done 设为 true、independent 设为 false。',
    '6. 学生在未到 ④ 档时自己做对最终结果 → done=true、independent=true。',
    '',
    '输出格式：每次只回复一个 JSON 对象（不要 Markdown 代码块、不要多余文字），字段：',
    '{',
    '  "say": "你这一轮要对学生说的话（一句问题或反馈，可用 <b> 强调）",',
    '  "cls": "" | "hint" | "praise",          // 普通/提示/表扬，用于气泡配色',
    '  "chips": ["建议回答1","建议回答2"],       // 可选，给学生的快捷选项',
    '  "hintLevel": 0,                          // 当前已揭示到的最高提示档 0-4',
    '  "correct": false,                        // 本轮学生回答是否正确（无关回合可省略）',
    '  "done": false,                           // 本题是否结束',
    '  "independent": false                     // done 时：是否未看 ④ 档就做对',
    '}'
  ].join('\n');

  /* ---------- 会话状态 ---------- */
  let convo = [];        // [{role:'user'|'assistant', content:string}]
  let curProblem = null;

  function kickoff(p) {
    const steps = p.steps.map((s, i) => (i + 1) + '. ' + stripTags(s.ask) + '（参考答案要点：' + s.accept[0] + '）').join('\n');
    // RAG：检索本题关联的课标知识，注入提示词为模型「接地」（PRD 7.1）
    let ragBlock = '';
    if (global.QisiRAG) {
      const hits = QisiRAG.retrieve(p.stem, p.knowledgeId, 3);
      if (hits.length) {
        ragBlock = '参考知识（检索自知识库，引导时据此保证内容正确、与课内对齐）：\n' + QisiRAG.asContext(hits) + '\n\n';
        if (global.QisiStore) QisiStore.track('rag_retrieve', { problemId: p.id, knowledgeId: p.knowledgeId, hits: hits.map(h => h.id).join(','), via: 'llm' });
      }
    }
    return [
      '题目：' + p.stem,
      '知识点：' + (p.tags || []).join('、'),
      '',
      ragBlock +
      '标准解法步骤（仅供你参考，不要直接念给学生）：',
      steps,
      '完整解答（仅在第 ④ 档才可给）：' + stripTags(p.fullSolution),
      '方法复盘：' + p.methodRecap,
      '',
      '现在开始：先给一句温暖的开场，并就「第一步该想什么」提出第一个问题。按 JSON 格式输出，hintLevel=0。'
    ].join('\n');
  }
  function ensureKickoff() {
    if (convo.length === 0 && curProblem) convo.push({ role: 'user', content: kickoff(curProblem) });
  }

  function reset(problem) { curProblem = problem; convo = []; }

  function start(problem) {
    reset(problem); ensureKickoff();
    return callClaude(convo).then(handleModel);
  }
  function turn(input) {
    ensureKickoff();
    convo.push({ role: 'user', content: input });
    return callClaude(convo).then(handleModel);
  }

  function handleModel(text) {
    convo.push({ role: 'assistant', content: text });
    const obj = parseJSON(text);
    if (!obj) {
      // 模型没按 JSON 返回：直接把文本当一句话（仍会过引擎后置校验）
      return { messages: [{ text: text, cls: '' }], chips: [], done: false };
    }
    return {
      messages: [{ text: obj.say || obj.message || '（无内容）', cls: obj.cls || '' }],
      chips: Array.isArray(obj.chips) ? obj.chips : [],
      hintLevel: obj.hintLevel,
      correct: obj.correct,
      done: !!obj.done,
      independent: !!obj.independent
    };
  }

  /* ---------- 调用 Claude（浏览器直连；生产改后端代理） ---------- */
  function callClaude(messages) {
    const c = getConfig();
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': c.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: c.model || 'claude-sonnet-4-6',
        max_tokens: 800,
        system: SYSTEM,
        messages: messages
      })
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('Anthropic ' + res.status + '：' + t.slice(0, 160)); });
      return res.json();
    }).then(function (data) {
      return (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
    });
  }

  /* ---------- 工具 ---------- */
  function parseJSON(text) {
    if (!text) return null;
    let t = text.trim().replace(/^```(json)?/i, '').replace(/```$/,'').trim();
    try { return JSON.parse(t); } catch (e) {}
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {} }
    return null;
  }
  function stripTags(s) { return String(s).replace(/<[^>]+>/g, ''); }

  global.QisiLLM = {
    getConfig: getConfig, setConfig: setConfig, enabled: enabled,
    start: start, turn: turn, reset: reset,
    _system: SYSTEM
  };
})(window);
