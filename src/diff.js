/** Word-level diff (LCS) between two revisions of campaign copy. */

const tokenize = (s) => s.split(/(?<=\s)(?=\S)/).filter((t) => t.length);

export function diffText(a, b) {
  const x = tokenize(a);
  const y = tokenize(b);
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);

  const n = xm.length;
  const m = ym.length;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = xm[i] === ym[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const ops = [];
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  if (pre) push('equal', x.slice(0, pre).join(''));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xm[i] === ym[j]) {
      push('equal', xm[i]);
      i++;
      j++;
    } else if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
      push('add', ym[j++]);
    } else {
      push('del', xm[i++]);
    }
  }
  if (suf) push('equal', x.slice(x.length - suf).join(''));
  return ops;
}
