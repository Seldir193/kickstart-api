// utils/billing.js

/** Parse yyyy-mm-dd to Date at local 00:00 */
function parseISODate(iso) {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return isNaN(d.getTime()) ? null : d;
}

/** Return { daysInMonth, daysRemaining, factor, firstMonthPrice } */
function prorateForStart(startISO, monthlyPrice) {
  const d = parseISODate(startISO);
  if (!d || typeof monthlyPrice !== 'number' || !isFinite(monthlyPrice)) {
    return { daysInMonth: null, daysRemaining: null, factor: null, firstMonthPrice: null };
  }
  const y = d.getFullYear();
  const m = d.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startDay = d.getDate();
  const daysRemaining = Math.max(0, daysInMonth - startDay + 1); // inkl. Starttag
  const factor = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
  const firstMonthPrice = Math.round(monthlyPrice * factor * 100) / 100;
  return { daysInMonth, daysRemaining, factor, firstMonthPrice };
}

/** Next subscription period start (1st of next month from startISO) → yyyy-mm-dd */
function nextPeriodStart(startISO) {
  const d = parseISODate(startISO);
  if (!d) return null;
  const y = d.getFullYear();
  const m = d.getMonth();
  const firstNext = new Date(y, m + 1, 1);
  const y2 = firstNext.getFullYear();
  const m2 = String(firstNext.getMonth() + 1).padStart(2, '0');
  const dd = '01';
  return `${y2}-${m2}-${dd}`;
}

/** Format amount to 2 decimals as string */
function fmtAmount(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

/** Currency guard */
function normCurrency(c) {
  return (String(c || 'EUR').toUpperCase());
}

module.exports = {
  prorateForStart,
  nextPeriodStart,
  fmtAmount,
  normCurrency,
};
