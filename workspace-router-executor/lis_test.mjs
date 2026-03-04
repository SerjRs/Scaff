function lengthOfLIS(nums) {
  const tails = [];
  for (const num of nums) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tails[mid] < num) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = num;
  }
  return tails.length;
}

const cases = [
  [[10, 9, 2, 5, 3, 7, 101, 18],  4],
  [[0, 1, 0, 3, 2, 3],            4],
  [[7, 7, 7, 7, 7],               1],
  [[1, 3, 6, 7, 9, 4, 10, 5, 6],  6],
  [[],                            0],
  [[5],                           1],
];

let passed = 0;
for (const [input, expected] of cases) {
  const result = lengthOfLIS(input);
  const ok = result === expected;
  console.log(`${ok ? "✅" : "❌"} LIS([${input}]) = ${result}  (expected ${expected})`);
  if (ok) passed++;
}
console.log(`\n${passed}/${cases.length} tests passed`);
