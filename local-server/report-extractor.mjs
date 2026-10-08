import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
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
  // Mammoth omits Word content-control checkbox symbols. Keep the selected state
  // as ordinary text for analysis; the member's original archive stays untouched.
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (file) {
    const source = await file.async('string');
    if (source.length > 12_000_000) throw new Error('weekly_report_document_xml_too_large');
    if (source.includes('checkbox')) {
      const xml = new DOMParser().parseFromString(source, 'application/xml');
      const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const extended = 'http://schemas.microsoft.com/office/word/2010/wordml';
      for (const control of Array.from(xml.getElementsByTagNameNS(word, 'sdt'))) {
        const properties = Array.from(control.childNodes).find(child => child.localName === 'sdtPr' && child.namespaceURI === word);
        const checkbox = properties?.getElementsByTagNameNS(extended, 'checkbox')[0];
        if (!checkbox) continue;
        const checked = checkbox.getElementsByTagNameNS(extended, 'checked')[0];
        const run = xml.createElementNS(word, 'w:r'), text = xml.createElementNS(word, 'w:t');
        text.textContent = ['1', 'true', 'on'].includes(checked?.getAttributeNS(extended, 'val')) ? '☑' : '☐';
        run.appendChild(text);
        control.parentNode.replaceChild(run, control);
      }
      zip.file('word/document.xml', new XMLSerializer().serializeToString(xml));
      buffer = await zip.generateAsync({ type: 'nodebuffer' });
    }
  }
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
