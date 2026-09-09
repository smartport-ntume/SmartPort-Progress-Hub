(() => {
  const FONT = {
    ascii: 'Arial',
    hAnsi: 'Arial',
    eastAsia: 'Microsoft JhengHei',
    cs: 'Arial'
  };
  const LANGUAGE = { value: 'en-US', eastAsia: 'zh-TW' };
  const NAVY = '1F3B63';
  const BLUE = 'DCE8F8';
  const PALE_BLUE = 'F3F7FC';
  const PALE_GRAY = 'F7F8FA';
  const BORDER_COLOR = 'D9D9D9';
  const TEXT = '172033';
  const MUTED = '667085';

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
      keepNext: !!options.keepNext,
      pageBreakBefore: !!options.pageBreakBefore
    });
  }

  function responseParagraph(prompt, blankLines = 2) {
    const children = [run(prompt, { color: MUTED, italics: true })];
    for (let index = 0; index < blankLines; index += 1) children.push(run(' ', { break: 1 }));
    return paragraph('', { children, spacing: { before: 20, after: 20, line: 276 } });
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

  function labelCell(text, width = 22) {
    return cell([paragraph(text, { bold: true, spacing: { before: 0, after: 0, line: 260 } })], {
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
        pageBreakBefore: !!options.pageBreakBefore,
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
    return { OVERDUE: '逾期未完成', ACTIVE: '目前進行中', UPCOMING: '30 天內到期' }[scope] || scope;
  }

  function evidenceText(task) {
    return task.expectedEvidence?.length
      ? task.expectedEvidence.map(item => `• ${item}`).join('\n')
      : valueText(task.description, '尚未設定預期成果；請依工作內容填寫可驗收產出。');
  }

  function metaTable(model) {
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
        labelCell('選題範圍', 15), cell(`逾期、進行中、${model.cutoffDate} 前到期且尚未完成`, { width: 35 })
      ])
    ], [15, 35, 15, 35]);
  }

  function overallStatus() {
    return table([
      row([
        labelCell('自評完成度', 18), cell([responseParagraph('____ %', 0)], { width: 32 }),
        labelCell('整體狀態', 18), cell([responseParagraph('☐ 正常　☐ 需注意　☐ 延誤', 0)], { width: 32 })
      ]),
      row([
        labelCell('本週摘要', 18),
        cell([responseParagraph('請用 3～5 句說明本週成果、與甘特圖差異及最需要關注的事項。', 4)], { columnSpan: 3 })
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

  function currentTaskTable(task) {
    return table([
      row([
        cell(`${task.id}　${task.name}`, { bold: true, fill: BLUE, columnSpan: 3 }),
        cell(scopeLabel(task.scope), { bold: true, fill: BLUE })
      ]),
      row([labelCell('所屬 WP'), cell(`${task.parentWp}　${task.parentWpName}`), labelCell('分類'), cell(`${task.categoryName} (${task.ownerTeam})`)]),
      row([labelCell('計畫期間'), cell(`${valueText(task.start)} ～ ${valueText(task.end)}`), labelCell('目標節點'), cell(valueText(task.targetCp))]),
      row([labelCell('上次進度'), cell(task.currentProgress == null ? '—' : `${task.currentProgress}%`), labelCell('目前狀態'), cell(task.currentStatus)]),
      row([labelCell('預期成果／證據'), cell(evidenceText(task), { columnSpan: 3 })]),
      row([labelCell('本週實際工作與成果'), cell([responseParagraph('請具體描述完成內容、結果及可驗證產出。', 4)], { columnSpan: 3 })]),
      row([labelCell('成果證據／連結'), cell([responseParagraph('請填文件、Issue、PR、測試結果、影片或其他證據。', 2)], { columnSpan: 3 })]),
      row([labelCell('回報進度／狀態'), cell([responseParagraph('完成度：____ %　　☐ 正常　☐ 需注意　☐ 延誤　☐ 已完成', 0)], { columnSpan: 3 })]),
      row([labelCell('阻礙／風險'), cell([responseParagraph('如無請填「無」；如有，請說明影響、原因及預估延誤。', 2)], { columnSpan: 3 })]),
      row([labelCell('需要 PM 協助'), cell([responseParagraph('如無請填「無」；如有，請明確列出決策、資源或跨組協調需求。', 2)], { columnSpan: 3 })]),
      row([labelCell('下一步／承諾日期'), cell([responseParagraph('下一個具體行動：　　　　　　　　　預計完成：YYYY/MM/DD', 1)], { columnSpan: 3 })])
    ], [22, 28, 22, 28]);
  }

  function upcomingTaskTable(task) {
    return table([
      row([
        cell(`${task.id}　${task.name}`, { bold: true, fill: BLUE, columnSpan: 3 }),
        cell(`30 天內到期　${task.end}`, { bold: true, fill: BLUE })
      ]),
      row([labelCell('所屬 WP'), cell(`${task.parentWp}　${task.parentWpName}`), labelCell('分類'), cell(`${task.categoryName} (${task.ownerTeam})`)]),
      row([labelCell('計畫期間'), cell(`${valueText(task.start)} ～ ${valueText(task.end)}`), labelCell('目標節點'), cell(valueText(task.targetCp))]),
      row([labelCell('預期成果／證據'), cell(evidenceText(task), { columnSpan: 3 })]),
      row([labelCell('本週準備／預計交付'), cell([responseParagraph('請列出為如期完成所需的準備、下一個具體行動、可驗收產出及日期。', 4)], { columnSpan: 3 })]),
      row([labelCell('就緒程度'), cell([responseParagraph('____ %', 0)]), labelCell('時程判斷'), cell([responseParagraph('☐ 可如期　☐ 有風險　☐ 需調整排程', 0)])]),
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
      row([labelCell('跨組依賴／共通風險', 25), cell([responseParagraph('請整合列出跨任務問題；如無請填「無」。', 3)], { width: 75 })]),
      row([labelCell('需要 PM 決策', 25), cell([responseParagraph('請寫成可直接決策的問題，並附建議選項與期限；如無請填「無」。', 3)], { width: 75 })])
    ], [25, 75]);
  }

  function pmReviewTable() {
    return table([
      row([labelCell('PM 回饋', 22), cell([responseParagraph('請填寫具體回饋、建議或肯定事項。', 4)], { width: 78 })]),
      row([labelCell('追蹤事項', 22), cell([responseParagraph('請列出責任人、待辦事項及追蹤期限；如無請填「無」。', 3)], { width: 78 })]),
      row([labelCell('審閱結果', 22), cell('☐ 通過　☐ 補充後通過　☐ 退回修改', { width: 78 })]),
      row([labelCell('PM 確認', 22), cell('PM 姓名：　　　　　　　　　確認日期：YYYY/MM/DD', { width: 78 })])
    ], [22, 78]);
  }

  function buildDocument(model) {
    const { AlignmentType, Document, PageOrientation } = api();
    const children = [
      paragraph('SMARTPORT PROGRESS HUB', { bold: true, size: 17, color: MUTED, alignment: AlignmentType.CENTER, spacing: { after: 80 } }),
      paragraph('每週個人工作進度報告', { bold: true, size: 34, color: '000000', alignment: AlignmentType.CENTER, spacing: { after: 30 } }),
      paragraph('WEEKLY INDIVIDUAL PROGRESS REPORT', { bold: true, size: 18, color: MUTED, alignment: AlignmentType.CENTER, spacing: { after: 260 } }),
      metaTable(model),
      spacer(120),
      paragraph(`系統已帶入 ${model.counts.total} 項工作：逾期 ${model.counts.overdue}、進行中 ${model.counts.active}、30 天內到期 ${model.counts.upcoming}。請勿刪除工作 ID，Codex 將依 ID 核對甘特圖。`, { color: MUTED, size: 18, spacing: { after: 160 } }),
      sectionBanner('1', '本週整體狀態　OVERALL STATUS'),
      overallStatus(),
      spacer(160),
      sectionBanner('2', '本週任務總覽　SYSTEM GENERATED TASK SCOPE'),
      overviewTable(model)
    ];

    if (model.currentTasks.length) {
      children.push(spacer(120), sectionBanner('3A', '逾期與進行中任務明細', { pageBreakBefore: true }));
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
      children.push(spacer(120), sectionBanner('3B', '未來 30 天內到期任務', { pageBreakBefore: true }));
      model.upcomingTasks.forEach((task, index) => {
        children.push(paragraph(`${task.id}　${task.name}`, {
          bold: true,
          size: 24,
          pageBreakBefore: index > 0,
          keepNext: true,
          spacing: { before: 140, after: 100, line: 300 }
        }), upcomingTaskTable(task));
      });
    }

    children.push(
      spacer(120),
      sectionBanner('4', '下週工作計畫　NEXT WEEK COMMITMENTS', { pageBreakBefore: true }),
      commitmentsTable(),
      spacer(160),
      sectionBanner('5', '跨任務問題與決策需求　ISSUES AND DECISIONS'),
      issuesTable(),
      spacer(160),
      sectionBanner('6', 'PM 審閱　PM REVIEW'),
      pmReviewTable(),
      spacer(100),
      paragraph('藍底欄位由系統依甘特圖自動帶入；灰色提示欄位由成員或 PM 直接覆寫。', { color: MUTED, size: 17 })
    );

    return new Document({
      creator: 'SmartPort Progress Hub',
      title: `SmartPort ${model.member.name} 每週個人工作進度報告`,
      description: `甘特圖自動產生之 ${model.reportDate} 個人週報`,
      styles: {
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
