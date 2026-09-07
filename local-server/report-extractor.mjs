import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import mammoth from 'mammoth';
import { runCommand } from './command.mjs';

function normalizeText(value) {
  const text = String(value || '')
    .replaceAll('\0', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (text.length > 2_000_000) throw new Error('weekly_report_extracted_text_too_large');
  return text;
}

async function docxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  const text = normalizeText(result.value);
  if (!text) throw new Error('weekly_report_contains_no_extractable_text');
  return {
    text,
    warnings: (result.messages || []).map(item => String(item.message || item)).filter(Boolean)
  };
}

async function convertLegacyDoc(buffer, options) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-doc-'));
  try {
    const input = path.join(temporary, 'weekly-report.doc');
    await fs.writeFile(input, buffer);
    await runCommand(options.libreOfficeBin || 'soffice', [
      '--headless', '--convert-to', 'docx', '--outdir', temporary, input
    ], { timeoutMs: 120_000 });
    const files = await fs.readdir(temporary);
    const outputName = files.find(name => name.toLowerCase().endsWith('.docx'));
    if (!outputName) throw new Error('libreoffice_did_not_create_docx');
    return fs.readFile(path.join(temporary, outputName));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('legacy_doc_requires_libreoffice_or_conversion_to_docx');
    }
    throw error;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function extractWeeklyReport({ filename, buffer, libreOfficeBin = 'soffice' }) {
  const extension = path.extname(String(filename || '')).toLowerCase();
  if (extension === '.docx') return docxText(buffer);
  if (extension === '.doc') {
    const converted = await convertLegacyDoc(buffer, { libreOfficeBin });
    const result = await docxText(converted);
    result.warnings.unshift('Legacy .doc was converted locally with LibreOffice before analysis.');
    return result;
  }
  throw new Error('weekly_report_file_must_be_doc_or_docx');
}
