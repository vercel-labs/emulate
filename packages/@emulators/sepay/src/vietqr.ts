export function crc16(data: string): string {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, "0") + value;
}

export interface VietQrInput {
  acc: string;
  bank: string;
  amount?: string | null;
  des?: string | null;
}

export function buildVietQrString({ acc, bank, amount, des }: VietQrInput): string {
  const merchantInfo = tlv("00", "A000000727") + tlv("01", tlv("00", bank) + tlv("01", acc) + tlv("02", "QRIBFTTA"));
  let payload =
    tlv("00", "01") +
    tlv("01", amount ? "12" : "11") +
    tlv("38", merchantInfo) +
    tlv("53", "704") +
    (amount ? tlv("54", String(parseInt(amount, 10))) : "") +
    tlv("58", "VN");
  if (des) payload += tlv("62", tlv("08", des));
  payload += "6304";
  return payload + crc16(payload);
}
