(() => {
  const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'DFKai-SB', cs: 'Arial' };
  const LANGUAGE = { value: 'en-US', eastAsia: 'zh-TW' };
  const INK = '182238';
  const MUTED = '637083';
  const ACCENT = '274A78';
  const PAPER = 'F7F9FC';
  const PALE = 'FFFFFF';
  const LINE = 'DFE5ED';
  const PAGE_WIDTH = 11906;
  const MARGIN = 960;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

  function api() {
    if (!window.docx) throw new Error('Word 產生器尚未載入，請重新整理頁面');
    return window.docx;
  }
  function run(text, options = {}) {
    return new (api().TextRun)({ text: String(text ?? ''), font: FONT, language: LANGUAGE,
      size: options.size || 22, color: options.color || INK, bold: !!options.bold, snapToGrid: false,
      break: options.break || 0, ...(options.children ? { children: options.children } : {}) });
  }
  function paragraph(text = '', options = {}) {
    return new (api().Paragraph)({
      children: options.children || String(text ?? '').split('\n').map((line, i) => run(line, { ...options, break: i ? 1 : 0 })),
      spacing: options.spacing || { before: 0, after: 65, line: 280 },
      keepNext: !!options.keepNext, keepLines: !!options.keepLines,
      pageBreakBefore: !!options.pageBreakBefore, style: options.style,
      alignment: options.alignment, tabStops: options.tabStops
    });
  }
  function spacer(size = 100, keepNext = false) {
    return paragraph('', { size: 2, keepNext, spacing: { before: 0, after: size, line: 20 } });
  }
  function hint(text, blankLines = 0, keepNext = false) {
    return paragraph('', { children: [run(text, { size: 19, color: MUTED }),
      ...Array.from({ length: blankLines }, () => run(' ', { break: 1 }))],
      keepNext, spacing: { before: 20, after: 30, line: 245 } });
  }
  function borders() {
    const line = { style: api().BorderStyle.SINGLE, color: LINE, size: 4 };
    const none = { style: api().BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    return { top: none, bottom: line, left: none, right: none, insideHorizontal: line, insideVertical: none };
  }
  function cell(content, options = {}) {
    return new (api().TableCell)({
      children: Array.isArray(content) ? content : [paragraph(content, options)],
      columnSpan: options.span, shading: options.fill ? { fill: options.fill, color: 'auto' } : undefined,
      verticalAlign: options.verticalAlign || api().VerticalAlign.CENTER,
      margins: { top: options.padding ?? 75, bottom: options.padding ?? 75, left: 150, right: 150 },
      borders: borders()
    });
  }
  function row(cells, { header = false, split = false } = {}) {
    return new (api().TableRow)({ children: cells, tableHeader: header, cantSplit: !split });
  }
  function table(rows, widths = [100]) {
    return new (api().Table)({ rows, width: { size: CONTENT_WIDTH, type: api().WidthType.DXA },
      layout: api().TableLayoutType.FIXED,
      columnWidths: widths.map(n => Math.round(CONTENT_WIDTH * n / 100)), borders: borders() });
  }
  function label(text, options = {}) {
    return paragraph(text, { bold: true, size: 20, color: '000000', keepNext: true,
      spacing: { before: 0, after: 65, line: 240 }, ...options });
  }
  function field(title, prompt, lines = 0, options = {}) {
    return cell([label(title), hint(prompt, lines, !!options.keepNext)], { verticalAlign: api().VerticalAlign.TOP, ...options });
  }
  function sectionHeading(number, title) {
    return paragraph(`${number}　${title}`, { bold: true, size: 26, color: '000000', keepNext: true,
      spacing: { before: 160, after: 100, line: 245 } });
  }
  function valueText(value, fallback = '—') { return String(value ?? '').trim() || fallback; }
  function scopeLabel(scope) {
    return { OVERDUE: '逾期未完成', ACTIVE: '目前進行中', UPCOMING: '下一 CP 前待辦', FOLLOWUP: '已完成待補充' }[scope] || scope;
  }
  function evidenceText(task) {
    return task.expectedEvidence?.length ? task.expectedEvidence.map(s => `• ${s}`).join('\n')
      : valueText(task.description, '依工作內容填寫本週成果。');
  }
  function metric(title, value, options = {}) {
    return cell([label(title, { size: 18 }), paragraph(value, { size: options.size || 25,
      bold: true, color: options.color || INK, spacing: { after: 20, line: 240 } })], {
      fill: options.fill || PAPER, verticalAlign: api().VerticalAlign.TOP });
  }
  function headerLabel(value) {
    let label = '', width = 0;
    for (const ch of String(value)) {
      width += /[^\x00-\x7f]/.test(ch) ? 2 : 1;
      if (width > 64) return `${label}…`;
      label += ch;
    }
    return label;
  }
  function documentHeader(model, context = '') {
    return new (api().Header)({ children: [paragraph('', { size: 17, color: MUTED,
      tabStops: [{ type: api().TabStopType.RIGHT, position: CONTENT_WIDTH }],
      children: [run(`SMARTPORT  /  ${model.weekId}`, { size: 17, color: '000000' }), run('\t'),
        run(headerLabel(context || model.member.name), { size: 17, color: '000000' })],
      spacing: { before: 0, after: 50, line: 210 } })] });
  }
  function documentFooter() {
    return new (api().Footer)({ children: [paragraph('', {
      tabStops: [{ type: api().TabStopType.RIGHT, position: CONTENT_WIDTH }],
      children: [run('台中港計畫  /  個人週報', { size: 16, color: MUTED }), run('\t'),
        run('', { size: 16, color: MUTED, children: [api().PageNumber.CURRENT] })],
      spacing: { before: 0, after: 0, line: 210 } })] });
  }
  function section(model, children, context = '') {
    return { properties: { type: api().SectionType.NEXT_PAGE, grid: { type: api().DocumentGridType.DEFAULT, linePitch: 280 },
      page: { size: { width: PAGE_WIDTH, height: 16838, orientation: api().PageOrientation.PORTRAIT },
        margin: { top: 820, right: MARGIN, bottom: 780, left: MARGIN, header: 370, footer: 360 } } },
      headers: { default: documentHeader(model, context) }, footers: { default: documentFooter() }, children };
  }

  function checkpointBlock(model) {
    const cp = model.nextCheckpoint;
    if (!cp) return [table([row([metric('後續 CP', '尚未設定'),
      cell([label('報告規則'), paragraph('僅追蹤逾期未完成項目')])])], [35, 65])];
    return [
      paragraph(`${cp.id}　${cp.name}　 ·　 ${cp.dateDisplay}　 ·　 倒數 ${cp.daysRemaining} 天`, { size: 24, bold: true, color: ACCENT,
        spacing: { before: 40, after: 120, line: 280 } }),
      table([row([
        cell([label('車輛能力 / Capability'), paragraph(valueText(cp.capability, '尚未設定'))]),
        cell([label('Review / Check'), paragraph(valueText(cp.reviewChecks, '尚未設定'))])
      ], { split: true })], [50, 50]),
      paragraph(`成熟度目標 ${valueText(cp.acl)}　 ·　 本期 ${model.counts.total} 項`, { size: 18, color: MUTED,
        spacing: { before: 65, after: 75, line: 240 } })
    ];
  }
  function overviewTable(model) {
    const rows = [row([
      cell('WP／Subtask 工作項目', { bold: true, fill: PAPER, color: '000000' }),
      cell('追蹤範圍', { bold: true, fill: PAPER, color: '000000' }),
      cell('計畫期間', { bold: true, fill: PAPER, color: '000000' }),
      cell('進度' , { bold: true, fill: PAPER, color: '000000', alignment: api().AlignmentType.CENTER })
    ], { header: true })];
    for (const task of model.tasks) rows.push(row([
      cell([paragraph(`${task.parentWp} · ${task.id} / ${task.categoryName}`, { size: 18, color: MUTED }), paragraph(task.name)]),
      cell(scopeLabel(task.scope), { size: 18 }), cell(`${valueText(task.start)}\n～ ${valueText(task.end)}`, { size: 18 }),
      cell([paragraph(task.currentProgress == null ? '—' : `${task.currentProgress}%`, { bold: true, size: 24, alignment: api().AlignmentType.CENTER }),
        paragraph(valueText(task.currentStatus), { size: 17, color: MUTED, alignment: api().AlignmentType.CENTER, spacing: { after: 0, line: 240 } })])
    ]));
    if (!model.tasks.length) rows.push(row([cell('本期沒有符合條件的未完成工作項目。', { span: 4 })]));
    return table(rows, [42, 21, 22, 15]);
  }
  function overviewPage(model) {
    return [
      paragraph('每週個人工作進度報告', { style: 'Title', bold: true, size: 38, color: '000000',
        spacing: { before: 50, after: 90, line: 245 } }),
      paragraph('WEEKLY WORK REPORT', { size: 18, color: '000000', spacing: { after: 100 } }),
      paragraph(`${model.member.name}　｜　${model.weekId}　｜　填報 ${model.reportDateDisplay}`, { size: 24, bold: true,
        spacing: { before: 50, after: 80, line: 280 } }),
      paragraph(`報告期間 ${model.periodDisplay}\n負責分類 ${model.categories.map(c => `${c.name} (${c.id})`).join('、')}`, {
        size: 19, spacing: { before: 90, after: 80, line: 250 } }),
      ...(model.publicationRevision > 1 ? [paragraph(`發布更新版 v${model.publicationRevision} · 本期週次與繳交連結不變`, { size: 18, color: MUTED })] : []),
      ...(model.previousReviewNotice ? [paragraph(`${model.previousReviewNotice.weekKey} · ${model.previousReviewNotice.label}`, { bold: true }),
        paragraph(model.previousReviewNotice.text, { size: 19, color: MUTED })] : []),
      sectionHeading('01', '下一個檢核點預覽'), ...checkpointBlock(model),
      table([row([
        cell([paragraph('', { children: [run('自評完成度　', { bold: true, size: 20 }), run('____ %', { size: 20, color: MUTED })] })]),
        cell([paragraph('', { children: [run('整體狀態　', { bold: true, size: 20 }), run('☐ 正常　☐ 需注意　☐ 延誤', { size: 20, color: MUTED })] })])
      ]), row([field('本週摘要', '請用 3～5 句說明本週成果、進度差異與最需要關注的事。', 1, { span: 2 })], { split: true })], [35, 65]),
      sectionHeading('02', '本週任務總覽'),
      paragraph(`逾期未完成 ${model.counts.overdue} 項　 ·　 目前進行中 ${model.counts.active} 項　 ·　 下一 CP 前待辦 ${model.counts.upcoming} 項`, {
        size: 18, color: MUTED, spacing: { after: 90, line: 240 } }),
      paragraph('上期核准進度由系統帶入；本週回報仍由 PM 確認。請保留工作 ID。', { size: 18, color: MUTED,
        spacing: { before: 0, after: 60, line: 240 }, keepNext: true }),
      overviewTable(model)
    ];
  }

  function feedbackTable(items = [], { response = true } = {}) {
    const entries = items.map(item => ({ id: item.target_id || '整份週報',
      lines: [...new Set([...(item.missing_items || []), ...(item.actions || [])].filter(Boolean))] })).filter(item => item.lines.length);
    if (!entries.length) return [];
    const rows = [row([cell('上期工作回饋', { bold: true, fill: PAPER, color: INK, keepNext: true })], { header: true })];
    // Separate advice rows allow long feedback to flow across pages without a
    // single tall, vertically centred cell swallowing its content at a page edge.
    for (const item of entries) {
      if (entries.length > 1) rows.push(row([cell([paragraph(item.id, { bold: true, size: 19, color: MUTED, keepNext: true })])]));
      for (const text of item.lines) rows.push(row([cell([
        paragraph(`• ${text}`, { size: 22, spacing: { after: 70, line: 280 } })
      ], { padding: 25, verticalAlign: api().VerticalAlign.TOP })], { split: true }));
    }
    if (response) rows.push(row([field('本週回覆與處理結果', '已處理什麼？未完成請寫原因與預計完成日。', 0)], { split: true }));
    return [spacer(160), table(rows)];
  }
  function checks(labels, alias) {
    return labels.flatMap((text, index) => [
      new (api().CheckBox)({ alias: `${alias} ${text}`, checked: false,
        checkedState: { value: '2611', font: 'Arial' }, uncheckedState: { value: '2610', font: 'Arial' } }),
      run(` ${text}${index < labels.length - 1 ? '　' : ''}`, { size: 18 })
    ]);
  }
  function stepTable(task) {
    const steps = task.steps?.length ? task.steps : Array.from({ length: 3 }, () => ({ name: '____________________', completion_percent: null }));
    return table([
      row([cell([label('完成工項的步驟'), hint(task.stepsFromWeek ? `沿用 ${task.stepsFromWeek}；本週勾選狀態，計畫變更時可直接修改。` : '括號填「完成這一步時，工項累計完成幾％」。步驟可自行增減。')], { span: 2 })], { header: true }),
      ...steps.map((step, index) => row([
        cell([paragraph(`${index + 1}. ${step.name}（${step.completion_percent ?? '__'}%）`, { size: 21, spacing: { before: 40, after: 40, line: 270 } })]),
        cell([paragraph('', { children: checks(['已完成', '進行中', '未開始'], `${task.id} 步驟 ${index + 1}`), spacing: { after: 0, line: 250 } })])
      ], { split: true }))
    ], [60, 40]);
  }
  function nextStepTable() {
    return table([row([
      field('下一步／承諾日期', '下一個具體行動：________________', 0, { fill: PALE }),
      field('預計完成日期', 'YYYY/MM/DD', 0, { fill: PALE }),
      field('優先度（擇一）', '☐ 高　☐ 中　☐ 低', 0, { fill: PALE })
    ], { split: true })], [49, 25, 26]);
  }
  function taskPage(task, model, index) {
    const upcoming = task.scope === 'UPCOMING';

    return [
      paragraph(`03　工項明細 ${String(index + 1).padStart(2, '0')} / ${String(model.tasks.length).padStart(2, '0')}　 ·　 ${scopeLabel(task.scope)}　 ·　 ${task.categoryName} (${task.ownerTeam})`, {
        size: 18, color: '000000', spacing: { before: 20, after: 90, line: 240 } }),
      paragraph(`${task.id}　${task.name}`, { bold: true, size: 32, color: '000000', keepNext: true,
        spacing: { before: 0, after: 70, line: 245 } }),
      paragraph(`${task.parentWp}　${task.parentWpName}`, { size: 19, color: MUTED, keepNext: true }),
      paragraph(`計畫期間 ${valueText(task.start)} ～ ${valueText(task.end)}　 ·　 目標節點 ${valueText(task.targetCp)}`, {
        size: 18, color: MUTED, spacing: { after: 135, line: 240 } }),
      table([row([
        metric('上期核准進度', task.currentProgress == null ? '—' : `${task.currentProgress}%`, { size: 30 }),
        metric('本週回報進度', '____ %', { size: 30, fill: PALE, color: ACCENT })
      ])], [50, 50]),
      paragraph('預期成果／證據', { bold: true, size: 19, spacing: { before: 100, after: 40, line: 240 } }),
      paragraph(evidenceText(task), { size: 19, color: MUTED, spacing: { after: 100, line: 250 } }),
      spacer(130), stepTable(task), ...feedbackTable(task.reviewFeedback), spacer(90),
      table([row([field('本週新增成果與進度說明',
        '寫下本週成果、測試結果及文件／連結，說明進度變化。', 2, { keepNext: true })], { split: true })]),
      spacer(90, true),
      ...(upcoming ? [table([row([
        field('就緒程度', '____ %', 0, { keepNext: true }), field('時程判斷', '☐ 可如期　☐ 有風險　☐ 需調整排程', 0, { keepNext: true })
      ])], [30, 70]), table([row([field('依賴／風險／需協助', '請列出前置條件、跨組依賴或 PM 決策；如無請填「無」。', 0, { keepNext: true })], { split: true })])]
        : [table([row([cell([paragraph('', { children: [run('本週狀態　', { bold: true, size: 20 }),
          run('☐ 正常　☐ 需注意　☐ 延誤　☐ 已完成', { size: 20, color: MUTED })], keepNext: true })], { span: 2 })]),
          row([field('阻礙／風險', '影響什麼？預計延誤多久？如無填「無」。', 0, { keepNext: true }),
            field('需要 PM 協助', '需要什麼協助？如無填「無」。', 0, { keepNext: true })], { split: true })], [50, 50])]),
      spacer(90, true), nextStepTable()
    ];
  }
  function reviewAndIssuesPage(model) {
    const previous = model.previousReview;
    return [
      ...(previous ? [sectionHeading('PM', '上期 PM 回饋與本週回覆'),
        paragraph(`${previous.weekKey} · 第 ${previous.revision} 版 · ${previous.reviewStatus === 'APPROVED' ? '已核准' : '退回補件'}`, { size: 19, color: MUTED }),
        table([row([cell([label('上期 PM 意見'), paragraph(previous.feedback || 'PM 已核准，未另填文字回饋。')], { fill: PAPER })], { split: true })]),
        ...feedbackTable(previous.generalFeedback, { response: false }),
        table([row([field('本週回覆與處理結果', '寫下已處理的事項；未完成請填原因與預計完成日。', 2)], { split: true })]),
        paragraph('以上為上期審閱紀錄；本週成果請填在回覆欄及工項明細。', { size: 18, color: MUTED,
          spacing: { before: 80, after: 130, line: 240 } })] : []),
      sectionHeading('04', '跨任務問題與決策需求　ISSUES AND DECISIONS'),
      table([row([field('跨組依賴／共通風險', '哪些事情需要其他組協助？請寫工作項目、對象與期限；如無填「無」。', 2)], { split: true }),
        row([field('需要 PM 決策', '需要 PM 決定什麼？請附選項與最晚決定日期；如無填「無」。', 2)], { split: true })])
    ];
  }
  function buildDocument(model) {
    const sections = [section(model, overviewPage(model), '本週總覽')];
    model.tasks.forEach((task, index) => sections.push(section(model, taskPage(task, model, index), `${task.parentWp} · ${task.id} · ${task.name}`)));
    for (const item of model.followupFeedback || []) sections.push(section(model, [
      sectionHeading('PM', `${item.target_id} 上期工作回饋追蹤`), ...feedbackTable([item]), spacer(130), nextStepTable()
    ], item.target_id));
    sections.push(section(model, reviewAndIssuesPage(model), 'PM 回饋與跨任務事項'));
    return new (api().Document)({ creator: 'SmartPort Progress Hub',
      title: `SmartPort ${model.member.name} 每週個人工作進度報告`,
      description: `甘特圖自動產生之 ${model.reportDate} 個人週報`,
      styles: {
        default: { title: { run: { font: FONT, size: 44, bold: true, color: '000000' } },
          document: { run: { font: FONT, language: LANGUAGE, size: 22, color: INK },
          paragraph: { spacing: { before: 0, after: 65, line: 280 } } } }
      }, sections });
  }
  async function create(model) { return api().Packer.toBlob(buildDocument(model)); }
  window.SmartPortWeeklyDocx = { buildDocument, create };
})();
