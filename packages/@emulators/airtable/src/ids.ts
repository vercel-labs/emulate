// Airtable ids are a type prefix + 14 base62 chars (e.g. `rec` + 14 = a 17-char
// record id). Generated ids are only used when the seed config omits one; seeded
// ids pass through verbatim so real base/table/field ids resolve unchanged.

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function randomSuffix(length = 14): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

export const generateBaseId = (): string => `app${randomSuffix()}`;
export const generateTableId = (): string => `tbl${randomSuffix()}`;
export const generateFieldId = (): string => `fld${randomSuffix()}`;
export const generateViewId = (): string => `viw${randomSuffix()}`;
export const generateRecordId = (): string => `rec${randomSuffix()}`;
export const generateCommentId = (): string => `com${randomSuffix()}`;
export const generateUserId = (): string => `usr${randomSuffix()}`;
