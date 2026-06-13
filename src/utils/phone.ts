/**
 * Normalizes Pakistan mobile numbers to standard format (923XXXXXXXXX)
 * Rules:
 * - 03XXXXXXXXX -> 923XXXXXXXXX
 * - 923XXXXXXXXX -> 923XXXXXXXXX
 * - +923XXXXXXXXX -> 923XXXXXXXXX
 */
export function normalizePakistanPhone(phone: string): string {
  if (!phone) return "";
  
  // Remove all non-digit characters
  let clean = phone.replace(/\D/g, "");
  
  if (clean.startsWith("03") && clean.length === 11) {
    return "92" + clean.slice(1);
  }
  
  if (clean.startsWith("923") && clean.length === 12) {
    return clean;
  }
  
  if (clean.startsWith("3") && clean.length === 10) {
    return "92" + clean;
  }
  
  return clean;
}

/**
 * Basic format validation of Pakistani mobile numbers
 */
export function isValidPakistanPhone(phone: string): boolean {
  if (!phone) return false;
  const normalized = normalizePakistanPhone(phone);
  return /^923\d{9}$/.test(normalized);
}
