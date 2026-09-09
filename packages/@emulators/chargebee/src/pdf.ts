function pdfText(value: string): string {
  return value
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function renderSimplePdf(title: string, lines: string[]): Buffer {
  const body = [
    "BT",
    "/F1 18 Tf",
    "50 740 Td",
    `(${pdfText(title)}) Tj`,
    "ET",
    "BT",
    "/F1 11 Tf",
    "50 710 Td",
    "14 TL",
    ...lines.map((line, index) => `${index === 0 ? "" : "T* "}(${pdfText(line)}) Tj`),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(body, "utf8")} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output, "utf8"));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(output, "utf8");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "utf8");
}

export function formatMoney(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

export function formatDate(seconds: number | null): string {
  if (seconds === null) return "";
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
