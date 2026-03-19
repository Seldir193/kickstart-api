"use strict";

function prorateForStart(dateISO, monthlyPrice) {
  const d = new Date(dateISO + "T00:00:00");
  if (
    isNaN(d.getTime()) ||
    typeof monthlyPrice !== "number" ||
    !isFinite(monthlyPrice)
  ) {
    return {
      daysInMonth: null,
      daysRemaining: null,
      factor: null,
      firstMonthPrice: null,
      monthlyPrice: monthlyPrice ?? null,
    };
  }
  const y = d.getFullYear();
  const m = d.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startDay = d.getDate();
  const daysRemaining = daysInMonth - startDay + 1;
  const factor = Math.max(0, Math.min(1, daysRemaining / daysInMonth));
  const firstMonthPrice = Math.round(monthlyPrice * factor * 100) / 100;
  return { daysInMonth, daysRemaining, factor, firstMonthPrice, monthlyPrice };
}

module.exports = { prorateForStart };
