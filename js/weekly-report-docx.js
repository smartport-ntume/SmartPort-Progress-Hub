(() => {
  const FONT = { ascii: 'Arial', hAnsi: 'Arial', eastAsia: 'DFKai-SB', cs: 'Arial' };
  const LANGUAGE = { value: 'en-US', eastAsia: 'zh-TW' };
  const INK = '242823';
  const MUTED = '687069';
  const ACCENT = '315B4C';
  const PAPER = 'F5F4EF';
  const PALE = 'F0F4F0';
  const LINE = 'D9D9D9';
  const PAGE_WIDTH = 11906;
  const MARGIN = 850;
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

  function api() {
    if (!window.docx) throw new Error('Word 產生器尚未載入，請重新整理頁面');
    return window.docx;
  }
  function run(text, options = {}) {
    return new (api().TextRun)({ text: String(text ?? ''), font: FONT, language: LANGUAGE,
      size: options.size || 21, color: options.color || INK, bold: !!options.bold, snapToGrid: false,
      break: options.break || 0, ...(options.children ? { children: options.children } : {}) });
  }
  function paragraph(text = '', options = {}) {
    return new (api().Paragraph)({
      children: options.children || String(text ?? '').split('\n').map((line, i) => run(line, { ...options, break: i ? 1 : 0 })),
      spacing: options.spacing || { before: 0, after: 55, line: 245 },
      keepNext: !!options.keepNext, keepLines: !!options.keepLines,
      pageBreakBefore: !!options.pageBreakBefore, style: options.style,
      alignment: options.alignment, tabStops: options.tabStops
    });
  }
  function spacer(size = 100) {
    return paragraph('', { size: 2, spacing: { before: 0, after: size, line: 20 } });
  }
  function hint(text, blankLines = 0) {
    return paragraph('', { children: [run(text, { size: 19, color: MUTED }),
      ...Array.from({ length: blankLines }, () => run(' ', { break: 1 }))],
      spacing: { before: 20, after: 30, line: 245 } });
  }
  function borders() {
    const line = { style: api().BorderStyle.SINGLE, color: LINE, size: 4 };
    return { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line };
  }
  function cell(content, options = {}) {
    return new (api().TableCell)({
      children: Array.isArray(content) ? content : [paragraph(content, options)],
      columnSpan: options.span, shading: options.fill ? { fill: options.fill, color: 'auto' } : undefined,
      verticalAlign: options.verticalAlign || api().VerticalAlign.CENTER,
      margins: { top: options.padding ?? 90, bottom: options.padding ?? 90, left: 150, right: 150 },
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
    return cell([label(title), hint(prompt, lines)], { verticalAlign: api().VerticalAlign.TOP, ...options });
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
      : valueText(task.description, '尚未設定預期成果；請依工作內容填寫可驗收產出。');
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
      table([row([metric('下一 CP', `${cp.id}　${cp.name}`, { size: 24 }),
        metric('檢核日期', cp.dateDisplay, { size: 24 }),
        metric('距離檢核', `倒數 ${cp.daysRemaining} 天`, { size: 24, color: ACCENT })])], [44, 29, 27]),
      table([row([
        cell([label('車輛能力 / Capability'), paragraph(valueText(cp.capability, '尚未設定'))]),
        cell([label('Review / Check'), paragraph(valueText(cp.reviewChecks, '尚未設定'))])
      ], { split: true })], [50, 50]),
      paragraph(`成熟度目標 ${valueText(cp.acl)}　 ·　 本期範圍 ${model.counts.total} 項`, { size: 18, color: MUTED,
        spacing: { before: 65, after: 75, line: 240 } })
    ];
  }
  function overviewTable(model) {
    const rows = [row([
      cell('WP／Subtask 工作項目', { bold: true, fill: PAPER, color: '000000' }),
      cell('追蹤範圍', { bold: true, fill: PAPER, color: '000000' }),
      cell('計畫期間', { bold: true, fill: PAPER, color: '000000' }),
      cell('進度／狀態', { bold: true, fill: PAPER, color: '000000', alignment: api().AlignmentType.CENTER })
    ], { header: true })];
    for (const task of model.tasks) rows.push(row([
      cell([paragraph(`${task.parentWp} · ${task.id} / ${task.categoryName}`, { size: 18, color: MUTED }), paragraph(task.name)]),
      cell(scopeLabel(task.scope)), cell(`${valueText(task.start)}\n～ ${valueText(task.end)}`, { size: 18 }),
      cell([paragraph(task.currentProgress == null ? '—' : `${task.currentProgress}%`, { bold: true, size: 24, alignment: api().AlignmentType.CENTER }),
        paragraph(valueText(task.currentStatus), { size: 17, color: MUTED, alignment: api().AlignmentType.CENTER, spacing: { after: 0, line: 240 } })])
    ]));
    if (!model.tasks.length) rows.push(row([cell('本期沒有符合條件的未完成工作項目。', { span: 4 })]));
    return table(rows, [44, 18, 24, 14]);
  }
  function overviewPage(model) {
    return [
      paragraph('每週個人工作進度報告', { style: 'Title', bold: true, size: 44, color: '000000',
        spacing: { before: 50, after: 90, line: 245 } }),
      paragraph('WEEKLY WORK REPORT', { size: 18, color: '000000', spacing: { after: 180 } }),
      table([row([
        metric('姓名', model.member.name, { size: 26 }),
        metric('週次', model.weekId, { size: 26 }),
        metric('填報日期', model.reportDateDisplay, { size: 26 })
      ])], [40, 30, 30]),
      paragraph(`報告期間 ${model.periodDisplay}\n負責分類 ${model.categories.map(c => `${c.name} (${c.id})`).join('、')}`, {
        size: 19, spacing: { before: 90, after: 80, line: 250 } }),
      ...(model.publicationRevision > 1 ? [paragraph(`發布更新版 v${model.publicationRevision} · 本期週次與繳交連結不變`, { size: 18, color: MUTED })] : []),
      ...(model.previousReviewNotice ? [paragraph(`${model.previousReviewNotice.weekKey} · ${model.previousReviewNotice.label}`, { bold: true }),
        paragraph(model.previousReviewNotice.text, { size: 19, color: MUTED })] : []),
      sectionHeading('01', '下一個檢核點預覽'), ...checkpointBlock(model),
      table([row([
        cell([paragraph('', { children: [run('自評完成度　', { bold: true, size: 20 }), run('____ %', { size: 20, color: MUTED })] })]),
        cell([paragraph('', { children: [run('整體狀態　', { bold: true, size: 20 }), run('☐ 正常　☐ 需注意　☐ 延誤', { size: 20, color: MUTED })] })])
      ]), row([field('本週摘要', '請用 3～5 句說明本週成果、與甘特圖差異及最需要關注的事項。', 2, { span: 2 })], { split: true })], [35, 65]),
      sectionHeading('02', '本週任務總覽'),
      paragraph(`逾期未完成 ${model.counts.overdue} 項　 ·　 目前進行中 ${model.counts.active} 項　 ·　 下一 CP 前待辦 ${model.counts.upcoming} 項`, {
        size: 18, color: MUTED, spacing: { after: 90, line: 240 } }),
      paragraph('上期核准進度由系統帶入；本週回報仍由 PM 確認。請保留工作 ID。', { size: 18, color: MUTED,
        spacing: { before: 0, after: 60, line: 240 }, keepNext: true }),
      overviewTable(model)
    ];
  }

  // One feedback table, with paired columns and one response field. Keep WP and
  // subtask attribution when both have advice, without duplicating the source.
  function feedbackTable(items = [], { response = true } = {}) {
    if (!items.length) return [];
    const rows = [row([
      cell('上期需要補充', { bold: true, fill: PAPER, color: '000000' }),
      cell('建議下一步', { bold: true, fill: PAPER, color: '000000' })
    ], { header: true })];
    for (const item of items) {
      const target = item.target_id || '整份週報';
      const content = lines => [paragraph(`${target}｜${lines?.length ? lines.join('\n• ') : '未另列事項。'}`, { size: 20 })];
      rows.push(row([cell(content(item.missing_items), { verticalAlign: api().VerticalAlign.TOP }),
        cell(content(item.actions), { verticalAlign: api().VerticalAlign.TOP })], { split: true }));
    }
    if (response) rows.push(row([field('本週回覆與處理結果', '請逐項回覆以上事項的處理結果與佐證；未完成請填原因及預計完成日。', 0, { span: 2 })], { split: true }));
    return [spacer(90), table(rows, [50, 50])];
  }
  function stepTable() {
    return table([
      row([cell([
        label('完成工項的步驟'),
        hint('依序列出步驟，狀態請填「已完成／進行中／未開始」；步驟可自行增減。'),
        paragraph('1. 步驟：________________　狀態：________\n2. 步驟：________________　狀態：________\n3. 步驟：________________　狀態：________', {
          size: 20, color: MUTED, spacing: { before: 45, after: 30, line: 245 } })
      ])], { split: true }),
      row([cell([label('目前做到哪一步'),
        paragraph('目前第 ____ 步／共 ____ 步；正在做：________________', { size: 20, color: MUTED }),
        hint('可填「未開始／全部完成」；並行步驟可複選。')], { fill: PALE })], { split: true })
    ]);
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
    const feedback = !!task.reviewFeedback?.length;
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
      stepTable(), ...feedbackTable(task.reviewFeedback), spacer(90),
      table([row([field(upcoming ? '本週準備／預計交付' : '本週新增成果與進度說明',
        upcoming ? '請填已完成的準備、進度變更原因及可驗收產出；後續行動及日期請填下方。'
          : '請說明本週新增成果，以及進度增加、持平或下修的原因。', feedback ? 1 : 2),
        field('成果證據／連結', '請附文件、Issue、PR、測試紀錄、影片或其他證據。', feedback ? 1 : 2)], { split: true })], [60, 40]),
      spacer(90),
      ...(upcoming ? [table([row([
        field('就緒程度', '____ %'), field('時程判斷', '☐ 可如期　☐ 有風險　☐ 需調整排程')
      ])], [30, 70]), table([row([field('依賴／風險／需協助', '請列出前置條件、跨組依賴或 PM 決策；如無請填「無」。', 0)], { split: true })])]
        : [table([row([cell([paragraph('', { children: [run('本週狀態　', { bold: true, size: 20 }),
          run('☐ 正常　☐ 需注意　☐ 延誤　☐ 已完成', { size: 20, color: MUTED })] })], { span: 2 })]),
          row([field('阻礙／風險', '如無請填「無」；如有，請說明影響、原因及預估延誤。'),
            field('需要 PM 協助', '如無請填「無」；如有，請明確列出決策、資源或跨組協調需求。')], { split: true })], [50, 50])]),
      spacer(90), nextStepTable()
    ];
  }
  function reviewAndIssuesPage(model) {
    const previous = model.previousReview;
    return [
      ...(previous ? [sectionHeading('PM', '上期 PM 回饋與本週回覆'),
        paragraph(`${previous.weekKey} · 第 ${previous.revision} 版 · ${previous.reviewStatus === 'APPROVED' ? '已核准' : '退回補件'}`, { size: 19, color: MUTED }),
        table([row([cell([label('上期 PM 意見'), paragraph(previous.feedback || 'PM 已核准，未另填文字回饋。')], { fill: PAPER })], { split: true })]),
        ...feedbackTable(previous.generalFeedback, { response: false }),
        table([row([field('本週回覆與處理結果', '請逐項回覆上期 PM 意見及共通回饋：已處理內容與佐證；未完成請填原因與預計完成日。', 2)], { split: true })]),
        paragraph('以上 PM 意見是上期審閱紀錄；本週成果請填在回覆欄及任務明細。', { size: 18, color: MUTED,
          spacing: { before: 80, after: 130, line: 240 } })] : []),
      sectionHeading('04', '跨任務問題與決策需求　ISSUES AND DECISIONS'),
      table([row([field('跨組依賴／共通風險', '請整合列出跨任務問題；如無請填「無」。', 2)], { split: true }),
        row([field('需要 PM 決策', '請寫成可直接決策的問題，並附建議選項與期限；如無請填「無」。', 2)], { split: true })])
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
          document: { run: { font: FONT, language: LANGUAGE, size: 21, color: INK },
          paragraph: { spacing: { before: 0, after: 55, line: 245 } } } }
      }, sections });
  }
  async function create(model) { return api().Packer.toBlob(buildDocument(model)); }
  window.SmartPortWeeklyDocx = { buildDocument, create };
})();
