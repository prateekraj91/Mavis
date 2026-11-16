// Synthetic MediaPipe hand: 21 landmarks for a pose, centred at (cx, cy).
// Poses: palm, fist, thumbs_up, pinch, point (index only), peace (index + middle).
export function hand(pose, cx = 0.5, cy = 0.5) {
  const P = (dx, dy) => ({ x: cx + dx, y: cy + dy, z: 0 });
  const lm = new Array(21);
  lm[0] = P(0, 0.12);
  const mcps = [[-0.03, 0.005], [0, 0], [0.03, 0.01], [0.055, 0.025]];
  const curledSet = {
    palm: [0, 0, 0, 0], fist: [1, 1, 1, 1], thumbs_up: [1, 1, 1, 1], pinch: [0, 0, 0, 0], point: [0, 1, 1, 1], peace: [0, 0, 1, 1],
  }[pose];
  mcps.forEach(([mx, my], i) => {
    const b = 5 + i * 4;
    lm[b] = P(mx, my);
    if (curledSet[i]) {
      lm[b + 1] = P(mx, my - 0.04); lm[b + 2] = P(mx, my - 0.01); lm[b + 3] = P(mx, my + 0.03);
    } else {
      lm[b + 1] = P(mx, my - 0.05); lm[b + 2] = P(mx, my - 0.085); lm[b + 3] = P(mx, my - 0.115);
    }
  });
  lm[1] = P(-0.04, 0.09);
  lm[2] = P(-0.065, 0.06);
  if (pose === 'fist') { lm[3] = P(-0.04, 0.04); lm[4] = P(-0.01, 0.03); }
  else if (pose === 'thumbs_up') { lm[3] = P(-0.07, 0); lm[4] = P(-0.07, -0.07); }
  else { lm[3] = P(-0.09, 0.035); lm[4] = P(-0.11, 0.01); }
  if (pose === 'pinch') {
    lm[6] = P(-0.05, -0.04); lm[7] = P(-0.065, -0.02); lm[8] = P(-0.08, 0);
    lm[3] = P(-0.08, 0.03); lm[4] = P(-0.085, 0.005);
  }
  return lm;
}
