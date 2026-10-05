(() => {
  const FONT = {
    ascii: 'Arial',
    hAnsi: 'Arial',
    eastAsia: 'DFKai-SB',
    cs: 'Arial'
  };
  const LANGUAGE = { value: 'en-US', eastAsia: 'zh-TW' };
  // Palette A: warm gray surfaces and ink headings, shared by all Word downloads.
  const NAVY = '363431';
  const BLUE = 'E5E0D8';
  const PALE_BLUE = 'F4F1EC';
  const PALE_GRAY = 'F5F3EF';
  const BORDER_COLOR = 'D9D9D9';
  const TEXT = '242321';
  const MUTED = '625E58';

  function api() {
    if (!window.docx) throw new Error('Word 產生器尚未載入，請重新整理頁面');
    return window.docx;
  }

  function borders() {
    const { BorderStyle } = api();
    const line = { style: BorderStyle.SINGLE, color: BORDER_COLOR, size: 4 };
    return { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line };
  }

  function run(text, options = {}) {
    const { TextRun } = api();
    return new TextRun({
      text: String(text ?? ''),
      font: FONT,
      language: LANGUAGE,
      color: options.color || TEXT,
      size: options.size || 20,
      bold: !!options.bold,
      italics: !!options.italics,
      break: options.break || 0
    });
  }

  function paragraph(text = '', options = {}) {
    const { AlignmentType, Paragraph } = api();
    const lines = String(text ?? '').split('\n');
    const children = options.children || lines.map((line, index) => run(line, {
      ...options,
      break: index ? 1 : 0
    }));
    return new Paragraph({
      children,
      alignment: options.alignment || AlignmentType.LEFT,
      spacing: options.spacing || { before: 0, after: 80, line: 276 },
      style: options.style,
      keepNext: !!options.keepNext,
      pageBreakBefore: !!options.pageBreakBefore
    });
  }

  function responseParagraph(prompt, blankLines = 2, keepNext = false) {
    const children = [run(prompt, { color: MUTED, italics: true })];
    for (let index = 0; index < blankLines; index += 1) children.push(run(' ', { break: 1 }));
    return paragraph('', { children, keepNext, spacing: { before: 20, after: 20, line: 276 } });
  }

  function cell(content, options = {}) {
    const { TableCell, VerticalAlign, WidthType } = api();
    const children = Array.isArray(content)
      ? content
      : [paragraph(content, { bold: options.bold, color: options.color, alignment: options.alignment })];
    return new TableCell({
      children,
      columnSpan: options.columnSpan,
      verticalAlign: options.verticalAlign || VerticalAlign.CENTER,
      width: options.width ? { size: options.width, type: WidthType.PERCENTAGE } : undefined,
      shading: options.fill ? { fill: options.fill, color: 'auto' } : undefined,
      margins: { top: 110, bottom: 110, left: 130, right: 130 },
      borders: borders()
    });
  }

  function labelCell(text, width = 22, keepNext = false) {
    return cell([paragraph(text, { bold: true, keepNext, spacing: { before: 0, after: 0, line: 260 } })], {
      fill: PALE_GRAY,
      width
    });
  }

  function table(rows, widths = []) {
    const { Table, TableLayoutType, WidthType } = api();
    return new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      columnWidths: widths.length ? widths.map(value => Math.round(value * 96)) : undefined,
      borders: borders()
    });
  }

  function row(cells, options = {}) {
    const { TableRow } = api();
    return new TableRow({ children: cells, cantSplit: options.cantSplit !== false, tableHeader: !!options.header });
  }

  function spacer(height = 100) {
    return paragraph('', { spacing: { before: 0, after: height, line: 200 } });
  }

  function sectionHeading(number, title, options = {}) {
    const { AlignmentType } = api();
    return [
      paragraph(`${number}　${title}`, {
        bold: true,
        size: 24,
        color: 'FFFFFF',
        alignment: AlignmentType.LEFT,
        spacing: { before: options.before ?? 180, after: 80, line: 300 },
        pageBreakBefore: false,
        keepNext: true
      })
    ];
  }

  function sectionBanner(number, title, options = {}) {
    return table([
      row([
        cell(sectionHeading(number, title, options), { fill: NAVY, columnSpan: 2 })
      ])
    ], [100]);
  }

  function valueText(value, fallback = '—') {
    const text = String(value ?? '').trim();
    return text || fallback;
  }

  function scopeLabel(scope) {
    return { OVERDUE: '逾期未完成', ACTIVE: '目前進行中', UPCOMING: '下一 CP 前待辦', FOLLOWUP: '已完成待補充' }[scope] || scope;
  }

  function evidenceText(task) {
    return task.expectedEvidence?.length
      ? task.expectedEvidence.map(item => `• ${item}`).join('\n')
      : valueText(task.description, '尚未設定預期成果；請依工作內容填寫可驗收產出。');
  }

  function metaTable(model) {
    const scope = model.nextCheckpoint
      ? `逾期，以及 ${model.nextCheckpoint.id} (${model.nextCheckpoint.dateDisplay}) 前應完成且尚未完成`
      : '未設定後續 CP；僅納入逾期未完成';
    return table([
      row([
        labelCell('姓名', 15), cell(model.member.name, { width: 35 }),
        labelCell('填報日期', 15), cell(model.reportDateDisplay, { width: 35 })
      ]),
      row([
        labelCell('負責分類', 15), cell(model.categories.map(item => `${item.name} (${item.id})`).join('、'), { width: 35 }),
        labelCell('週次', 15), cell(model.weekId, { width: 35 })
      ]),
      row([
        labelCell('報告期間', 15), cell(model.periodDisplay, { width: 35 }),
        labelCell('選題範圍', 15), cell(scope, { width: 35 })
      ])
    ], [15, 35, 15, 35]);
  }

  function overallStatus() {
    return table([
      row([
        labelCell('自評完成度', 18, true), cell([responseParagraph('____ %', 0, true)], { width: 32 }),
        labelCell('整體狀態', 18, true), cell([responseParagraph('☐ 正常　☐ 需注意　☐ 延誤', 0, true)], { width: 32 })
      ]),
      row([
        labelCell('本週摘要', 18),
        cell([responseParagraph('請用 3～5 句說明本週成果、與甘特圖差異及最需要關注的事項。', 4)], { columnSpan: 3 })
      ])
    ], [18, 32, 18, 32]);
  }

  function taskPreview(tasks, emptyText = '無') {
    if (!tasks.length) return emptyText;
    const limit = 4;
    const visible = tasks.slice(0, limit).map(item => `${item.id} ${item.name}`);
    if (tasks.length > limit) visible.push(`另 ${tasks.length - limit} 項見後續任務總覽`);
    return visible.join('、');
  }

  function checkpointPreviewTable(model) {
    const checkpoint = model.nextCheckpoint;
    if (!checkpoint) {
      return table([
        row([
          labelCell('後續 CP', 18), cell('尚未設定', { width: 32 }),
          labelCell('報告規則', 18), cell('僅追蹤逾期未完成項目', { width: 32 })
        ]),
        row([
          labelCell('逾期未完成', 18),
          cell(taskPreview(model.tasks.filter(item => item.scope === 'OVERDUE')), { columnSpan: 3 })
        ])
      ], [18, 32, 18, 32]);
    }
    const overdue = model.tasks.filter(item => item.scope === 'OVERDUE');
    const active = model.tasks.filter(item => item.scope === 'ACTIVE');
    const upcoming = model.tasks.filter(item => item.scope === 'UPCOMING');
    const checkpointName = [checkpoint.id, checkpoint.name].filter(Boolean).join('　');
    return table([
      row([
        labelCell('下一 CP', 18), cell(checkpointName, { width: 32, bold: true }),
        labelCell('檢核日期', 18), cell(`${checkpoint.dateDisplay}（倒數 ${checkpoint.daysRemaining} 天）`, { width: 32, bold: true })
      ]),
      row([
        labelCell('成熟度目標', 18), cell(valueText(checkpoint.acl), { width: 32 }),
        labelCell('範圍工作', 18), cell(`${model.counts.total} 項`, { width: 32 })
      ]),
      row([
        labelCell('車輛能力 /\nCapability', 18),
        cell(valueText(checkpoint.capability, '尚未設定'), { columnSpan: 3 })
      ]),
      row([
        labelCell('Review / Check', 18),
        cell(valueText(checkpoint.reviewChecks, '尚未設定'), { columnSpan: 3 })
      ]),
      row([
        labelCell(`逾期未完成 ${overdue.length} 項`, 18),
        cell(taskPreview(overdue), { columnSpan: 3 })
      ]),
      row([
        labelCell(`CP 前進行中 ${active.length} 項`, 18),
        cell(taskPreview(active), { columnSpan: 3 })
      ]),
      row([
        labelCell(`CP 前尚未開始 ${upcoming.length} 項`, 18),
        cell(taskPreview(upcoming), { columnSpan: 3 })
      ])
    ], [18, 32, 18, 32]);
  }

  function overviewTable(model) {
    const rows = [row([
      cell('範圍', { bold: true, fill: BLUE, width: 12 }),
      cell('分類', { bold: true, fill: BLUE, width: 13 }),
      cell('WP', { bold: true, fill: BLUE, width: 12 }),
      cell('Subtask／工作項目', { bold: true, fill: BLUE, width: 31 }),
      cell('計畫期間', { bold: true, fill: BLUE, width: 17 }),
      cell('目前狀態', { bold: true, fill: BLUE, width: 15 })
    ], { header: true })];
    if (!model.tasks.length) {
      rows.push(row([cell('本期沒有符合條件的未完成工作項目。', { columnSpan: 6 })]));
    } else {
      model.tasks.forEach((task, index) => rows.push(row([
        cell(scopeLabel(task.scope), { fill: index % 2 ? PALE_BLUE : 'FFFFFF' }),
        cell(task.categoryName, { fill: index % 2 ? PALE_BLUE : 'FFFFFF' }),
        cell(task.parentWp, { fill: index % 2 ? PALE_BLUE : 'FFFFFF' }),
        cell(`${task.id}\n${task.name}`, { fill: index % 2 ? PALE_BLUE : 'FFFFFF' }),
        cell(`${valueText(task.start)}\n～ ${valueText(task.end)}`, { fill: index % 2 ? PALE_BLUE : 'FFFFFF' }),
        cell(`${task.currentProgress == null ? '—' : `${task.currentProgress}%`}\n${task.currentStatus}`, { fill: index % 2 ? PALE_BLUE : 'FFFFFF' })
      ])));
    }
    return table(rows, [12, 13, 12, 31, 17, 15]);
  }

  function taskFeedbackRows(items = [], span = 3) {
    if (!items.length) return [];
    return [...items.flatMap(item => [
      ...(item.missing_items?.length ? [row([labelCell(`上期需要補充\n${item.target_id || '整份週報'}`), cell(item.missing_items.map(text=>`• ${text}`).join('\n'), { columnSpan: span })], { cantSplit: false })] : []),
      ...(item.actions?.length ? [row([labelCell(`上期建議下一步\n${item.target_id || '整份週報'}`), cell(item.actions.map(text=>`• ${text}`).join('\n'), { columnSpan: span })], { cantSplit: false })] : [])
    ]), row([labelCell('本週回覆與處理結果'), cell([responseParagraph('請逐項回覆以上事項的處理結果與佐證；未完成請填原因及預計完成日。', 1)], { columnSpan: span })], { cantSplit: false })];
  }

  function currentTaskTable(task) {
    const hasFeedback = !!task.reviewFeedback?.length;
    return table([
      row([
        cell(`${task.id}　${task.name}`, { bold: true, fill: BLUE, columnSpan: 3 }),
        cell(scopeLabel(task.scope), { bold: true, fill: BLUE })
      ], { header: true }),
      row([labelCell('所屬 WP'), cell(`${task.parentWp}　${task.parentWpName}`), labelCell('分類'), cell(`${task.categoryName} (${task.ownerTeam})`)]),
      row([labelCell('計畫期間'), cell(`${valueText(task.start)} ～ ${valueText(task.end)}`), labelCell('目標節點'), cell(valueText(task.targetCp))]),
      row([labelCell('上期核准進度'), cell(task.currentProgress == null ? '—' : `${task.currentProgress}%`), labelCell('本週回報進度'), cell([responseParagraph('____ %', 0)])]),
      row([labelCell('預期成果／證據'), cell(evidenceText(task), { columnSpan: 3 })]),
      ...taskFeedbackRows(task.reviewFeedback),
      row([labelCell('本週新增成果與進度說明'), cell([responseParagraph('本週完成哪些工作？請說明進度增加、持平或下修的原因，並附成果數值、圖表或證據。', hasFeedback ? 2 : 4)], { columnSpan: 3 })]),
      row([labelCell('成果證據／連結'), cell([responseParagraph('請填文件、Issue、PR、測試結果、影片或其他證據。', hasFeedback ? 1 : 2)], { columnSpan: 3 })]),
      row([labelCell('本週狀態'), cell([responseParagraph('☐ 正常　☐ 需注意　☐ 延誤　☐ 已完成', 0)], { columnSpan: 3 })]),
      row([labelCell('阻礙／風險'), cell([responseParagraph('如無請填「無」；如有，請說明影響、原因及預估延誤。', hasFeedback ? 1 : 2)], { columnSpan: 3 })]),
      row([labelCell('需要 PM 協助'), cell([responseParagraph('如無請填「無」；如有，請明確列出決策、資源或跨組協調需求。', hasFeedback ? 1 : 2)], { columnSpan: 3 })]),
      row([labelCell('下一步／承諾日期'), cell([responseParagraph('下一個具體行動：　　　　　　　　　預計完成：YYYY/MM/DD', hasFeedback ? 0 : 1)], { columnSpan: 3 })])
    ], [22, 28, 22, 28]);
  }

  function upcomingTaskTable(task, model) {
    const checkpoint = model.nextCheckpoint?.id || '下一 CP';
    return table([
      row([
        cell(`${task.id}　${task.name}`, { bold: true, fill: BLUE, columnSpan: 3 }),
        cell(`${checkpoint} 前待辦　${valueText(task.end, task.targetCp)}`, { bold: true, fill: BLUE })
      ]),
      row([labelCell('所屬 WP'), cell(`${task.parentWp}　${task.parentWpName}`), labelCell('分類'), cell(`${task.categoryName} (${task.ownerTeam})`)]),
      row([labelCell('計畫期間'), cell(`${valueText(task.start)} ～ ${valueText(task.end)}`), labelCell('目標節點'), cell(valueText(task.targetCp))]),
      row([labelCell('上期核准進度'), cell(task.currentProgress == null ? '—' : `${task.currentProgress}%`), labelCell('本週回報進度'), cell([responseParagraph('____ %', 0)])]),
      row([labelCell('預期成果／證據'), cell(evidenceText(task), { columnSpan: 3 })]),
      ...taskFeedbackRows(task.reviewFeedback),
      row([labelCell('本週準備／預計交付'), cell([responseParagraph('請列出本週完成的準備、進度變更原因、下一個具體行動、可驗收產出及日期。', 4)], { columnSpan: 3 })]),
      row([labelCell('就緒程度'), cell([responseParagraph('____ %', 0)]), labelCell('時程判斷'), cell(['☐ 可如期', '☐ 有風險', '☐ 需調整排程'].map(text => paragraph(text, { color: MUTED, spacing: { after: 20, line: 260 } })))]),
      row([labelCell('依賴／風險／需協助'), cell([responseParagraph('請列出前置條件、跨組依賴或 PM 決策；如無請填「無」。', 2)], { columnSpan: 3 })])
    ], [22, 28, 22, 28]);
  }

  function commitmentsTable() {
    const rows = [row([
      cell('項次', { bold: true, fill: BLUE, width: 8 }),
      cell('優先', { bold: true, fill: BLUE, width: 16 }),
      cell('WP／Subtask', { bold: true, fill: BLUE, width: 24 }),
      cell('具體行動與預期成果', { bold: true, fill: BLUE, width: 37 }),
      cell('承諾日期', { bold: true, fill: BLUE, width: 15 })
    ], { header: true })];
    for (let index = 1; index <= 3; index += 1) {
      rows.push(row([
        cell(String(index)),
        cell('☐ 高　☐ 中　☐ 低'),
        cell('請填 WP／Subtask'),
        cell([responseParagraph('請填可驗收的下一步與預期成果', 1)]),
        cell('YYYY/MM/DD')
      ]));
    }
    return table(rows, [8, 16, 24, 37, 15]);
  }

  function issuesTable() {
    return table([
      row([labelCell('跨組依賴／共通風險', 25), cell([responseParagraph('請整合列出跨任務問題；如無請填「無」。', 2)], { width: 75 })]),
      row([labelCell('需要 PM 決策', 25), cell([responseParagraph('請寫成可直接決策的問題，並附建議選項與期限；如無請填「無」。', 2)], { width: 75 })])
    ], [25, 75]);
  }

  function buildDocument(model) {
    const { AlignmentType, Document, PageOrientation } = api();
    const children = [
      paragraph('SMARTPORT PROGRESS HUB', { bold: true, size: 17, color: MUTED, alignment: AlignmentType.CENTER, spacing: { after: 80 } }),
      paragraph('每週個人工作進度報告', { style: 'Title', bold: true, size: 34, color: '000000', alignment: AlignmentType.CENTER, spacing: { after: 30 } }),
      paragraph('WEEKLY INDIVIDUAL PROGRESS REPORT', { bold: true, size: 18, color: MUTED, alignment: AlignmentType.CENTER, spacing: { after: 260 } }),
      ...(model.publicationRevision > 1 ? [paragraph(`發布更新版 v${model.publicationRevision} · 本期週次與繳交連結不變`, { color: MUTED, alignment: AlignmentType.CENTER })] : []),
      metaTable(model),
      spacer(120),
      ...(model.previousReviewNotice ? [
        paragraph(`${model.previousReviewNotice.weekKey} · ${model.previousReviewNotice.label}`, { bold: true }),
        paragraph(model.previousReviewNotice.text, { color: MUTED }), spacer(120)
      ] : []),
      ...(model.previousReview ? [
        sectionBanner('PM', '上期 PM 回饋與本週回覆'),
        table([
          row([labelCell('上期審閱'), cell(`${model.previousReview.weekKey} · 第 ${model.previousReview.revision} 版 · ${model.previousReview.reviewStatus === 'APPROVED' ? '已核准' : '退回補件'}`)]),
          row([labelCell('上期 PM 意見'), cell(model.previousReview.feedback || 'PM 已核准，未另填文字回饋。')], { cantSplit: false }),
          ...taskFeedbackRows(model.previousReview.generalFeedback, 1),
          row([labelCell('本週回覆與處理結果'), cell([responseParagraph('請逐項回覆上期 PM 意見：本週已處理的內容、佐證；未完成事項請填原因與預計完成日。', 8)])], { cantSplit: false })
        ], [22, 78]),
        paragraph('以上 PM 意見是上期審閱紀錄；本週成果請填在回覆欄及任務明細。', { color: MUTED, size: 18 }),
        spacer(120)
      ] : []),
      paragraph('', { size: 2, spacing: { after: 0, line: 20 }, pageBreakBefore: !!model.previousReview, keepNext: true }),
      sectionBanner('CP', '下一個檢核點預覽　NEXT CHECKPOINT PREVIEW'),
      checkpointPreviewTable(model),
      spacer(120),
      paragraph('上期核准進度由系統帶入；本週回報進度由成員填寫，經 PM 在網站確認後更新正式進度。請保留工作 ID。', { color: MUTED, size: 18, spacing: { after: 160 } }),
      paragraph('', { size: 2, spacing: { after: 0, line: 20 }, pageBreakBefore: false, keepNext: true }),
      sectionBanner('1', '本週整體狀態　OVERALL STATUS'),
      overallStatus(),
      spacer(160),
      sectionBanner('2', '本週任務總覽　SYSTEM GENERATED TASK SCOPE'),
      overviewTable(model)
    ];

    if (model.currentTasks.length) {
      children.push(paragraph('', { size: 2, spacing: { after: 0, line: 20 }, pageBreakBefore: true, keepNext: true }), sectionBanner('3A', '逾期與進行中任務明細'));
      model.currentTasks.forEach((task, index) => {
        children.push(paragraph(`${task.id}　${task.name}`, {
          bold: true,
          size: 24,
          pageBreakBefore: index > 0,
          keepNext: true,
          spacing: { before: 140, after: 100, line: 300 }
        }), currentTaskTable(task));
      });
    }

    if (model.upcomingTasks.length) {
      children.push(paragraph('', { size: 2, spacing: { after: 0, line: 20 }, pageBreakBefore: true, keepNext: true }), sectionBanner('3B', `${model.nextCheckpoint?.id || '下一 CP'} 前尚未開始任務`));
      model.upcomingTasks.forEach((task, index) => {
        children.push(paragraph(`${task.id}　${task.name}`, {
          bold: true,
          size: 24,
          pageBreakBefore: index > 0,
          keepNext: true,
          spacing: { before: 140, after: 100, line: 300 }
        }), upcomingTaskTable(task, model));
      });
    }

    for (const item of model.followupFeedback || []) {
      children.push(paragraph(`${item.target_id} 上期工作回饋追蹤`, { bold: true, size: 24, pageBreakBefore: true, keepNext: true }),
        table(taskFeedbackRows([item], 1), [22, 78]));
    }

    children.push(
      paragraph('', { size: 2, spacing: { before: 0, after: 0, line: 20 }, pageBreakBefore: true, keepNext: true }),
      sectionBanner('4', '下週工作計畫　NEXT WEEK COMMITMENTS'),
      commitmentsTable(),
      spacer(160),
      sectionBanner('5', '跨任務問題與決策需求　ISSUES AND DECISIONS'),
      issuesTable()
    );

    return new Document({
      creator: 'SmartPort Progress Hub',
      title: `SmartPort ${model.member.name} 每週個人工作進度報告`,
      description: `甘特圖自動產生之 ${model.reportDate} 個人週報`,
      styles: {
        paragraphStyles: [{ id: 'Title', name: 'Title', basedOn: 'Normal', run: { font: FONT, size: 34, bold: true, color: '000000' } }],
        default: {
          document: {
            run: { font: FONT, language: LANGUAGE, size: 20, color: TEXT },
            paragraph: { spacing: { after: 80, line: 276 } }
          }
        }
      },
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT },
            margin: { top: 720, right: 820, bottom: 720, left: 820, header: 360, footer: 360 }
          }
        },
        children
      }]
    });
  }

  async function create(model) {
    const { Packer } = api();
    return Packer.toBlob(buildDocument(model));
  }

  window.SmartPortWeeklyDocx = { buildDocument, create };
})();
