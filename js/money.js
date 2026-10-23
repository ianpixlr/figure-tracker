// Ringgit amounts are stored as numbers and calculated in cents.

export function parseMoney(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100) / 100;
  }
  let text = String(input ?? '').trim();
  if (!text) return null;
  text = text.replace(/rm/gi, '').replace(/\s+/g, '');
  if (text.includes(',') && text.includes('.')) text = text.replace(/,/g, '');
  else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');
  else text = text.replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const amount = Number(text);
  if (!Number.isFinite(amount)) return null;
  return Math.round(amount * 100) / 100;
}

export function toCents(value) {
  const amount = typeof value === 'number' ? value : parseMoney(value);
  if (amount == null || !Number.isFinite(Number(amount))) return null;
  return Math.round(Number(amount) * 100);
}

export function fromCents(cents) {
  return cents / 100;
}

export function formatRM(value) {
  const cents = toCents(value);
  const amount = cents == null ? 0 : cents / 100;
  const sign = amount < 0 ? '-' : '';
  const [whole, fraction] = Math.abs(amount).toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}RM ${grouped}.${fraction}`;
}
