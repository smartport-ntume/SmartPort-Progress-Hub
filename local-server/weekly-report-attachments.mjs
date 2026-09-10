import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as docx from 'docx';

export const DISCORD_FILES_PER_MESSAGE = 5;
export const WEEKLY_DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MAX_WEEKLY_DOCX_BYTES = 10 * 1024 * 1024;

let browserModulesPromise;

async function browserModules() {
  if (!browserModulesPromise) {
    browserModulesPromise = (async () => {
      const window = { docx };
      const context = vm.createContext({
        window,
        Date,
        JSON,
        Map,
        Set,
        Intl,
        Blob,
        Uint8Array,
        ArrayBuffer,
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        crypto
      });
      const [modelCode, documentCode] = await Promise.all([
        readFile(new URL('../js/weekly-report-model.js', import.meta.url), 'utf8'),
        readFile(new URL('../js/weekly-report-docx.js', import.meta.url), 'utf8')
      ]);
      vm.runInContext(modelCode, context, { filename: 'weekly-report-model.js' });
      vm.runInContext(documentCode, context, { filename: 'weekly-report-docx.js' });
      if (!window.SmartPortWeeklyReport?.build || !window.SmartPortWeeklyDocx?.create) {
        throw new Error('weekly_report_generator_unavailable');
      }
      return window;
    })().catch(error => {
      browserModulesPromise = null;
      throw error;
    });
  }
  return browserModulesPromise;
}

function uniqueFilename(filename, memberId, used) {
  const normalized = String(filename || 'SmartPort_Weekly_Report.docx').slice(0, 180);
  const key = normalized.toLocaleLowerCase('en-US');
  if (!used.has(key)) {
    used.add(key);
    return normalized;
  }
  const suffix = String(memberId || 'member')
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 40) || 'member';
  const deduplicated = `${normalized.replace(/\.docx$/i, '').slice(0, 130)}_${suffix}.docx`;
  used.add(deduplicated.toLocaleLowerCase('en-US'));
  return deduplicated;
}

export async function createWeeklyReportAttachments(payload = {}) {
  const modules = await browserModules();
  const members = payload?.team_config?.members || [];
  const attachments = [];
  const usedFilenames = new Set();

  for (const member of members) {
    const model = modules.SmartPortWeeklyReport.build({
      teamConfig: payload.team_config,
      workPackages: payload.work_packages,
      subtasks: payload.subtasks,
      checkpoints: payload.checkpoints,
      checkpointReferences: payload.checkpoint_references,
      memberId: member.id,
      reportDate: payload.report_date
    });
    const blob = await modules.SmartPortWeeklyDocx.create(model);
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (buffer.length < 4 || buffer.subarray(0, 2).toString() !== 'PK') {
      throw new Error(`weekly_report_docx_invalid:${member.id}`);
    }
    if (buffer.length > MAX_WEEKLY_DOCX_BYTES) {
      throw new Error(`weekly_report_docx_too_large:${member.id}`);
    }
    attachments.push({
      memberId: String(member.id || '').slice(0, 100),
      memberName: String(member.name || member.id || '未命名成員').trim().slice(0, 80),
      filename: uniqueFilename(model.filename, member.id, usedFilenames),
      contentType: WEEKLY_DOCX_MIME,
      buffer
    });
  }
  return attachments;
}

export function chunkWeeklyReportAttachments(attachments, size = DISCORD_FILES_PER_MESSAGE) {
  if (!Number.isInteger(size) || size < 1 || size > DISCORD_FILES_PER_MESSAGE) {
    throw new Error('invalid_discord_attachment_chunk_size');
  }
  const chunks = [];
  for (let index = 0; index < attachments.length; index += size) {
    chunks.push(attachments.slice(index, index + size));
  }
  return chunks;
}

export function discordAttachmentForm(content, attachments) {
  const form = new FormData();
  form.set('payload_json', JSON.stringify({
    content,
    allowed_mentions: { parse: [] },
    attachments: attachments.map((attachment, index) => ({
      id: index,
      filename: attachment.filename,
      description: `${attachment.memberName} 的 SmartPort 個人週報`.slice(0, 100)
    }))
  }));
  attachments.forEach((attachment, index) => {
    form.set(
      `files[${index}]`,
      new Blob([attachment.buffer], { type: attachment.contentType }),
      attachment.filename
    );
  });
  return form;
}
