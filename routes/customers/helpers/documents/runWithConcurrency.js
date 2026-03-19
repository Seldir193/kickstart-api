"use strict";

async function runWithConcurrency(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, limit) }, async () => {
    while (true) {
      const my = idx++;
      if (my >= items.length) break;
      await worker(items[my], my);
    }
  });
  await Promise.all(runners);
}

module.exports = { runWithConcurrency };
