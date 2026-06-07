/* ==========================================================================
 * 启思 AI 家教 — 知识库 + 检索器 (kb.js)  ·  轻量 RAG
 * --------------------------------------------------------------------------
 * 课标对齐的「公式 / 定理 / 方法 / 易错点」知识条目，独立于题库。
 * QisiRAG.retrieve() 是一个稀疏检索器（知识点匹配 + 关键词重叠打分），
 * 在 AI 模式下把检索结果注入提示词给模型「接地」，保证引导与课内对齐、
 * 内容正确（PRD 7.1）；在拍题确认页也会可视化展示检索结果。
 * 后续可把打分换成向量嵌入（embedding）检索，接口不变。
 * ======================================================================== */
(function (global) {
  'use strict';

  // type: 公式 / 定理 / 方法 / 概念 / 易错点 / 性质
  const KB = [
    /* 有理数运算 */
    { id: 'k_numop_order', kid: 'num_op', type: '方法', title: '有理数混合运算顺序',
      text: '先算乘方，再算乘除，最后加减；有括号先算括号里的。', kw: ['运算顺序', '乘方', '括号', '加减', '乘除'] },
    { id: 'k_numop_add', kid: 'num_op', type: '法则', title: '有理数加法法则',
      text: '同号两数相加，取相同符号，并把绝对值相加；异号相加，取绝对值较大数的符号，并用大绝对值减小绝对值。', kw: ['加法', '同号', '异号', '绝对值'] },
    { id: 'k_numop_abs', kid: 'num_op', type: '概念', title: '绝对值',
      text: '|a| 表示 a 到原点的距离，恒非负：a≥0 时 |a|=a，a<0 时 |a|=−a。', kw: ['绝对值', '距离', '非负'] },

    /* 整式运算 */
    { id: 'k_poly_like', kid: 'poly', type: '方法', title: '合并同类项',
      text: '同类项：所含字母相同且相同字母的指数也相同。合并时系数相加减，字母与指数不变。', kw: ['同类项', '合并', '系数', '指数'] },
    { id: 'k_poly_diffsq', kid: 'poly', type: '公式', title: '平方差公式',
      text: '(a+b)(a−b)=a²−b²。', kw: ['平方差', '乘法公式', 'a²', 'b²', '(a+b)(a-b)'] },
    { id: 'k_poly_persq', kid: 'poly', type: '公式', title: '完全平方公式',
      text: '(a±b)²=a²±2ab+b²。', kw: ['完全平方', '乘法公式', '2ab'] },

    /* 因式分解 */
    { id: 'k_factor_common', kid: 'factor', type: '方法', title: '提公因式法',
      text: '找各项公因式：系数取最大公约数、字母取相同字母的最低次幂，提到括号外。', kw: ['公因式', '提取', '最大公约数', '最低次幂'] },
    { id: 'k_factor_cross', kid: 'factor', type: '方法', title: '二次三项式分解（十字相乘）',
      text: 'x²+(p+q)x+pq=(x+p)(x+q)；找两数之积等于常数项、之和等于一次项系数。', kw: ['十字相乘', '二次三项式', '积', '和', 'p', 'q'] },
    { id: 'k_factor_def', kid: 'factor', type: '概念', title: '因式分解的本质',
      text: '把多项式化成几个整式的积，与整式乘法互为逆运算；要分解到不能再分解为止。', kw: ['因式分解', '积', '逆运算', '分解到底'] },

    /* 一元一次方程 */
    { id: 'k_lineq_steps', kid: 'linear_eq', type: '方法', title: '解一元一次方程步骤',
      text: '去分母 → 去括号 → 移项（变号）→ 合并同类项 → 系数化为 1。', kw: ['移项', '变号', '系数化为1', '去括号', '去分母'] },
    { id: 'k_lineq_eqprop', kid: 'linear_eq', type: '性质', title: '等式的基本性质',
      text: '等式两边同时加（减）同一个数或式，或同乘（除以）同一非零数，等式仍成立。', kw: ['等式性质', '两边', '同时', '非零'] },

    /* 一元二次方程·求解 */
    { id: 'k_quad_general', kid: 'quad_eq', type: '概念', title: '一元二次方程一般式',
      text: 'ax²+bx+c=0（a≠0），a、b、c 为系数。', kw: ['一般式', '一元二次', 'a≠0', 'ax²'] },
    { id: 'k_quad_methods', kid: 'quad_eq', type: '方法', title: '解法选择',
      text: '能分解优先因式分解；形如 x²=a 直接开平方；通用可配方法或求根公式。', kw: ['因式分解', '直接开平方', '配方法', '求根公式', '解法'] },
    { id: 'k_quad_formula', kid: 'quad_eq', type: '公式', title: '求根公式与判别式',
      text: 'x=(−b±√(b²−4ac))/(2a)；判别式 Δ=b²−4ac：Δ>0 两不等实根，Δ=0 两相等实根，Δ<0 无实根。', kw: ['求根公式', '判别式', 'Δ', 'b²-4ac', '实根'] },
    { id: 'k_quad_sqrt', kid: 'quad_eq', type: '方法', title: '直接开平方法',
      text: 'x²=a（a≥0）⇒ x=±√a，注意正负两个根都要写。', kw: ['直接开平方', '正负', '两个根', '±'] },

    /* 一元二次方程·应用题 */
    { id: 'k_quadapp_steps', kid: 'quad_app', type: '方法', title: '列方程解应用题步骤',
      text: '设未知数 → 找等量关系 → 用代数式表示各量 → 列方程 → 解并按实际意义取舍。', kw: ['设未知数', '等量关系', '列方程', '取舍'] },
    { id: 'k_quadapp_geo', kid: 'quad_app', type: '关系', title: '常见几何数量关系',
      text: '矩形：面积=长×宽，周长=2×(长+宽)。', kw: ['矩形', '面积', '周长', '长', '宽'] },
    { id: 'k_quadapp_reject', kid: 'quad_app', type: '易错点', title: '按实际意义取舍根',
      text: '长度、个数、人数、年龄等不能为负或非整数，须舍去不符合题意的根。', kw: ['取舍', '负根', '实际意义', '舍去', '正值'] },

    /* 一次函数 */
    { id: 'k_func_def', kid: 'linear_func', type: '概念', title: '一次函数定义',
      text: 'y=kx+b（k≠0）：k 是斜率，b 是 y 轴截距；k>0 时 y 随 x 增大而增大，k<0 时减小。', kw: ['一次函数', 'k', 'b', '斜率', '截距'] },
    { id: 'k_func_undetermined', kid: 'linear_func', type: '方法', title: '待定系数法求解析式',
      text: '设 y=kx+b，把已知点坐标代入得到关于 k、b 的方程组，解出 k、b。', kw: ['待定系数', '代入', '点', '方程组', '解析式'] },
    { id: 'k_func_value', kid: 'linear_func', type: '方法', title: '求函数值',
      text: '已知自变量 x，代入解析式按运算顺序（先乘后加减）算出 y。', kw: ['代入', '函数值', '自变量', '求值'] }
  ];

  const byKid = (kid) => KB.filter(e => e.kid === kid);

  /* ---------- 稀疏检索器 ----------
   * 打分：同知识点 +5；query 命中关键词每个 +2；命中标题/正文片段 +1。
   * 返回 top-k（不足则用同知识点条目补齐），保证模型/界面总能拿到接地材料。
   */
  function retrieve(query, kid, k) {
    k = k || 3;
    const q = String(query || '');
    const scored = KB.map(e => {
      let s = 0;
      if (kid && e.kid === kid) s += 5;
      e.kw.forEach(w => { if (q.indexOf(w) >= 0) s += 2; });
      if (q && (q.indexOf(e.title) >= 0)) s += 1;
      return { e: e, s: s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);

    let hits = scored.slice(0, k).map(x => x.e);
    if (hits.length < k && kid) {
      byKid(kid).forEach(e => { if (hits.length < k && hits.indexOf(e) < 0) hits.push(e); });
    }
    return hits;
  }

  // 拼成给 LLM 的「参考资料」文本块
  function asContext(hits) {
    if (!hits || !hits.length) return '';
    return hits.map(e => '- 【' + e.type + '】' + e.title + '：' + e.text).join('\n');
  }

  global.QisiKB = { KB: KB, byKid: byKid };
  global.QisiRAG = { retrieve: retrieve, asContext: asContext };
})(window);
