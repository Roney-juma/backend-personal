const PDFDocument = require('pdfkit');

const NAVY = '#1B3A5C';
const WHITE = '#FFFFFF';
const GRAY_BG = '#F5F7FA';
const GRAY_BORDER = '#E2E8F0';
const DARK = '#1A202C';
const MUTED = '#718096';

function generateInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;
    const LEFT = 50;
    const RIGHT = PAGE_W - 50;
    const USABLE = RIGHT - LEFT;

    // ── Header band ──────────────────────────────────
    doc.rect(0, 0, PAGE_W, 105).fill(NAVY);

    doc.font('Helvetica-Bold').fontSize(24).fillColor(WHITE)
       .text('AVE', LEFT, 28, { lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor('#FFFFFFBF')
       .text('Provider Platform', LEFT, 57, { lineBreak: false });

    doc.font('Helvetica-Bold').fontSize(30).fillColor(WHITE)
       .text('INVOICE', LEFT, 25, { width: USABLE, align: 'right', lineBreak: false });

    const { invoiceNumber = '', status = 'draft' } = invoice;
    doc.font('Helvetica').fontSize(11).fillColor('#FFFFFFCC')
       .text(`#${invoiceNumber}`, LEFT, 64, { width: USABLE, align: 'right', lineBreak: false });

    // ── Bill To + Meta row ────────────────────────────
    let y = 122;
    const compName = invoice.company?.companyName ?? 'N/A';
    const compEmail = invoice.company?.email ?? '';

    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
       .text('BILL TO', LEFT, y, { lineBreak: false });
    y += 14;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(DARK)
       .text(compName, LEFT, y, { lineBreak: false });
    y += 18;
    if (compEmail) {
      doc.font('Helvetica').fontSize(10).fillColor(MUTED)
         .text(compEmail, LEFT, y, { lineBreak: false });
      y += 16;
    }

    const metaLabelX = RIGHT - 200;
    const metaValueX = RIGHT - 90;
    const metaValueW = 80;
    const metaRows = [
      ['Issue Date', new Date(invoice.createdAt || Date.now()).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })],
      ['Due Date',   new Date(invoice.dueDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })],
      ['Status',     status.charAt(0).toUpperCase() + status.slice(1)],
      ['Currency',   invoice.currency || 'USD'],
    ];
    let metaY = 122;
    metaRows.forEach(([label, value]) => {
      doc.font('Helvetica').fontSize(9).fillColor(MUTED)
         .text(label, metaLabelX, metaY, { width: 100, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
         .text(value, metaValueX, metaY, { width: metaValueW, align: 'right', lineBreak: false });
      metaY += 17;
    });

    y = Math.max(y, metaY) + 12;

    // Divider
    doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(GRAY_BORDER).stroke();
    y += 16;

    // ── Line items table ──────────────────────────────
    const COL_DESC_X  = LEFT + 8;
    const COL_DESC_W  = USABLE * 0.43;
    const COL_QTY_X   = LEFT + USABLE * 0.50;
    const COL_QTY_W   = 40;
    const COL_PRICE_X = LEFT + USABLE * 0.60;
    const COL_PRICE_W = 90;
    const COL_TOTAL_X = LEFT + USABLE * 0.79;
    const COL_TOTAL_W = USABLE * 0.21 - 8;

    // Header row
    doc.rect(LEFT, y, USABLE, 22).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(WHITE);
    doc.text('Description', COL_DESC_X,  y + 7, { width: COL_DESC_W,  lineBreak: false });
    doc.text('Qty',         COL_QTY_X,   y + 7, { width: COL_QTY_W,   align: 'right', lineBreak: false });
    doc.text('Unit Price',  COL_PRICE_X, y + 7, { width: COL_PRICE_W, align: 'right', lineBreak: false });
    doc.text('Total',       COL_TOTAL_X, y + 7, { width: COL_TOTAL_W, align: 'right', lineBreak: false });
    y += 22;

    const items = invoice.items || [];
    const cur = invoice.currency || 'USD';

    items.forEach((item, idx) => {
      const ROW_H = 22;
      doc.rect(LEFT, y, USABLE, ROW_H).fill(idx % 2 === 0 ? WHITE : GRAY_BG);
      const desc = (item.description || '').length > 55
        ? item.description.substring(0, 52) + '…'
        : (item.description || '');
      doc.font('Helvetica').fontSize(9).fillColor(DARK);
      doc.text(desc,                              COL_DESC_X,  y + 7, { width: COL_DESC_W,  lineBreak: false });
      doc.text(String(item.quantity),              COL_QTY_X,   y + 7, { width: COL_QTY_W,   align: 'right', lineBreak: false });
      doc.text(`${cur} ${(item.unitPrice || 0).toFixed(2)}`, COL_PRICE_X, y + 7, { width: COL_PRICE_W, align: 'right', lineBreak: false });
      doc.text(`${cur} ${(item.total || 0).toFixed(2)}`,     COL_TOTAL_X, y + 7, { width: COL_TOTAL_W, align: 'right', lineBreak: false });
      y += ROW_H;
    });

    doc.rect(LEFT, y, USABLE, 0.5).fill(GRAY_BORDER);
    y += 16;

    // ── Totals ────────────────────────────────────────
    const TOT_X = RIGHT - 220;
    const TOT_LABEL_W = 110;
    const TOT_VALUE_X = RIGHT - 90;
    const TOT_VALUE_W = 80;

    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
       .text('Subtotal', TOT_X, y, { width: TOT_LABEL_W, lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(DARK)
       .text(`${cur} ${(invoice.subtotal || 0).toFixed(2)}`, TOT_VALUE_X, y, { width: TOT_VALUE_W, align: 'right', lineBreak: false });
    y += 18;

    doc.font('Helvetica').fontSize(10).fillColor(MUTED)
       .text(`Tax (${invoice.taxRate || 0}%)`, TOT_X, y, { width: TOT_LABEL_W, lineBreak: false });
    doc.font('Helvetica').fontSize(10).fillColor(DARK)
       .text(`${cur} ${(invoice.tax || 0).toFixed(2)}`, TOT_VALUE_X, y, { width: TOT_VALUE_W, align: 'right', lineBreak: false });
    y += 22;

    // Total highlight box
    doc.rect(TOT_X, y, 220, 32).fill(NAVY);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(WHITE)
       .text('Total Due', TOT_X + 10, y + 9, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(12).fillColor(WHITE)
       .text(`${cur} ${(invoice.total || 0).toFixed(2)}`, TOT_X, y + 9, { width: 210, align: 'right', lineBreak: false });
    y += 48;

    // ── Notes ─────────────────────────────────────────
    if (invoice.notes) {
      doc.moveTo(LEFT, y).lineTo(RIGHT, y).lineWidth(0.5).strokeColor(GRAY_BORDER).stroke();
      y += 14;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
         .text('NOTES', LEFT, y, { lineBreak: false });
      y += 14;
      doc.font('Helvetica').fontSize(10).fillColor(DARK)
         .text(invoice.notes, LEFT, y, { width: USABLE });
      y = doc.y + 10;
    }

    // ── Footer ────────────────────────────────────────
    const FOOTER_H = 55;
    const footerY = PAGE_H - FOOTER_H;
    doc.rect(0, footerY, PAGE_W, FOOTER_H).fill(GRAY_BG);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED)
       .text(
         'Please ensure payment is made by the due date. Thank you for your business.',
         LEFT, footerY + 13, { width: USABLE, align: 'center', lineBreak: false }
       );
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text('AVE Provider Platform', LEFT, footerY + 30, { width: USABLE, align: 'center', lineBreak: false });

    doc.end();
  });
}

module.exports = generateInvoicePdf;
