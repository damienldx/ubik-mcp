/**
 * Document Generator — Create XLSX, CSV, DOCX, PDF, HTML files from structured JSON data.
 * Ported from UBIK ULTRA and adapted for Cyber Punk standalone architecture.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

interface GenerateDocResult {
  success: boolean;
  output?: string;
  error?: string;
  path?: string;
  size?: number;
}

/**
 * Generate a document file from structured JSON data.
 *
 * Supported formats:
 * - xlsx: { sheets: [{ name, headers, rows }] } or { headers, rows }
 * - csv:  { headers, rows, separator? }
 * - docx: { sections: [{ heading?, level?, paragraph?, list?, table? }] }
 * - pdf:  { title?, sections: [{ heading?, text?, list?, table? }] }
 * - html: { title?, body }
 */
export async function generateDocument(
  format: string,
  filePath: string,
  dataJson: string,
): Promise<GenerateDocResult> {
  if (!format || !filePath || !dataJson) {
    return { success: false, error: "Paramètres requis: format, path, data" };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = JSON.parse(dataJson);
  } catch {
    return { success: false, error: "data doit être du JSON valide" };
  }

  try {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    switch (format.toLowerCase()) {
      case "xlsx": {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const sheets = data.sheets || [{ name: "Sheet1", headers: data.headers, rows: data.rows }];
        for (const sheet of sheets) {
          const headers: string[] = sheet.headers || [];
          const rows: string[][] = sheet.rows || [];
          const ws = wb.addWorksheet(sheet.name || `Sheet${sheets.indexOf(sheet) + 1}`);
          // Add header row
          if (headers.length > 0) {
            const headerRow = ws.addRow(headers);
            headerRow.font = { bold: true };
          }
          // Add data rows
          for (const row of rows) {
            ws.addRow(row);
          }
          // Auto-size columns
          headers.forEach((h: string, ci: number) => {
            const maxLen = Math.max(
              String(h || "").length,
              ...rows.map((r: string[]) => String(r[ci] || "").length)
            );
            const col = ws.getColumn(ci + 1);
            col.width = Math.min(Math.max(maxLen + 2, 8), 50);
          });
        }
        await wb.xlsx.writeFile(filePath);
        break;
      }

      case "csv": {
        const sep = data.separator || ",";
        const headers = data.headers || [];
        const rows = data.rows || [];
        const escapeCsv = (v: string) => {
          const s = String(v ?? "");
          return s.includes(sep) || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        };
        const lines = [
          headers.map(escapeCsv).join(sep),
          ...rows.map((r: string[]) => r.map(escapeCsv).join(sep)),
        ];
        await fs.writeFile(filePath, lines.join("\n"), "utf-8");
        break;
      }

      case "docx": {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const docx: any = await import("docx");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const children: any[] = [];

        for (const section of data.sections || []) {
          if (section.heading) {
            children.push(new docx.Paragraph({
              text: section.heading,
              heading: section.level === 1 ? docx.HeadingLevel.HEADING_1
                : section.level === 2 ? docx.HeadingLevel.HEADING_2
                  : docx.HeadingLevel.HEADING_3,
              spacing: { before: 240, after: 120 },
            }));
          }
          if (section.paragraph) {
            children.push(new docx.Paragraph({
              text: section.paragraph,
              spacing: { after: 120 },
            }));
          }
          if (section.list) {
            for (const item of section.list) {
              children.push(new docx.Paragraph({
                text: item,
                bullet: { level: 0 },
                spacing: { after: 60 },
              }));
            }
          }
          if (section.table) {
            const tbl = new docx.Table({
              rows: [
                new docx.TableRow({
                  tableHeader: true,
                  children: (section.table.headers || []).map((h: string) =>
                    new docx.TableCell({
                      children: [new docx.Paragraph({
                        children: [new docx.TextRun({ text: h, bold: true })],
                      })],
                      shading: { fill: "E8E8E8" },
                    })
                  ),
                }),
                ...(section.table.rows || []).map((row: string[]) =>
                  new docx.TableRow({
                    children: row.map((cell: string) =>
                      new docx.TableCell({
                        children: [new docx.Paragraph({ text: String(cell) })],
                      })
                    ),
                  })
                ),
              ],
              width: { size: 100, type: docx.WidthType.PERCENTAGE },
            });
            children.push(tbl);
          }
        }

        const doc = new docx.Document({
          sections: [{
            properties: {},
            children,
          }],
        });
        const buffer = await docx.Packer.toBuffer(doc);
        await fs.writeFile(filePath, buffer);
        break;
      }

      case "pdf": {
        const PDFDocument = (await import("pdfkit")).default;
        const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
          const doc = new PDFDocument({ margin: 50, size: "A4" });
          const chunks: Buffer[] = [];
          doc.on("data", (chunk: Buffer) => chunks.push(chunk));
          doc.on("end", () => resolve(Buffer.concat(chunks)));
          doc.on("error", reject);

          // Title
          if (data.title) {
            doc.fontSize(20).font("Helvetica-Bold").text(data.title, { align: "center" });
            doc.moveDown(1.5);
          }

          for (const section of data.sections || []) {
            if (section.heading) {
              doc.fontSize(14).font("Helvetica-Bold").text(section.heading);
              doc.moveDown(0.5);
            }
            if (section.text) {
              doc.fontSize(11).font("Helvetica").text(section.text);
              doc.moveDown(0.5);
            }
            if (section.list) {
              doc.fontSize(11).font("Helvetica");
              for (const item of section.list) {
                doc.text(`  •  ${item}`, { indent: 15 });
              }
              doc.moveDown(0.5);
            }
            if (section.table) {
              const headers = section.table.headers || [];
              const rows = section.table.rows || [];
              const colW = (doc.page.width - 100) / Math.max(headers.length, 1);

              // Header row
              doc.fontSize(10).font("Helvetica-Bold");
              let x = 50;
              for (const h of headers) {
                doc.text(String(h), x, doc.y, { width: colW, continued: false });
                x += colW;
              }
              doc.moveDown(0.3);
              doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).stroke();
              doc.moveDown(0.3);

              // Data rows
              doc.font("Helvetica").fontSize(10);
              for (const row of rows) {
                x = 50;
                const startY = doc.y;
                for (let ci = 0; ci < headers.length; ci++) {
                  doc.text(String(row[ci] ?? ""), x, startY, { width: colW });
                  x += colW;
                }
                doc.moveDown(0.2);
              }
              doc.moveDown(0.5);
            }
          }

          doc.end();
        });
        await fs.writeFile(filePath, pdfBuffer);
        break;
      }

      case "html": {
        const htmlContent = `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.title || "Document"}</title>
    <style>
        :root {
            --bg: #0c0c14;
            --surface: #12121e;
            --surface-2: #1a1a2e;
            --border: #2a2a3e;
            --text: #e0e0f0;
            --text-muted: #8888aa;
            --accent: #6c5ce7;
            --accent-light: #a29bfe;
            --success: #00b894;
            --warning: #fdcb6e;
            --danger: #e17055;
            --info: #74b9ff;
        }
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 0 auto; padding: 40px 20px; background: var(--bg); color: var(--text); line-height: 1.6; }
        table { border-collapse: collapse; width: 100%; margin: 1em 0; }
        th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; }
        th { background: var(--surface-2); font-weight: 600; color: var(--text); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
        tr:nth-child(even) { background: var(--surface); }
        tr:hover td { background: rgba(255,255,255,0.02); }
        h1 { background: linear-gradient(135deg, var(--accent-light), var(--info)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
        h2 { color: var(--text); }
        h3 { color: var(--text-muted); }
        a { color: var(--accent-light); }
        code { background: var(--surface-2); color: var(--accent-light); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; }
        pre { background: var(--surface); padding: 16px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--border); }
    </style>
</head>
<body>
${data.body || ""}
</body>
</html>`;
        await fs.writeFile(filePath, htmlContent, "utf-8");
        break;
      }

      default:
        return { success: false, error: `Format non supporté: ${format}. Formats: xlsx, csv, docx, pdf, html` };
    }

    const stats = await fs.stat(filePath);
    const sizeKB = Math.round(stats.size / 1024);

    return {
      success: true,
      output: `Document ${format.toUpperCase()} généré: ${filePath} (${sizeKB} KB)`,
      path: filePath,
      size: stats.size,
    };
  } catch (err) {
    return {
      success: false,
      error: `Erreur génération ${format}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
