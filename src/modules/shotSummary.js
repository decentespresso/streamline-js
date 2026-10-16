// Generates a markdown shot summary from a Rea Prime shot record
// (GET /api/v1/shots/{id} shape: { measurements[], workflow, annotations }).
//
// Phases come from machine.profileFrame indexing workflow.profile.steps[];
// control type from step.pump; per-sample targets from targetPressure/targetFlow
// and the phase target temperature from step.temperature. Values render as
// actual(target).

const num = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? '-' : Number(v).toFixed(d));

export function generateShotSummary(shot) {
  const ms = shot?.measurements;
  if (!Array.isArray(ms) || ms.length === 0) return '## Shot Summary\n\n_No measurements._';

  const profile = shot.workflow?.profile || {};
  const steps = profile.steps || [];
  const ctx = shot.workflow?.context || {};
  const ann = shot.annotations || {};

  // Extraction starts once the machine leaves shot prep (flush/fill).
  let startIdx = ms.findIndex((m) => m.machine?.state?.substate !== 'preparingForShot');
  if (startIdx < 0) startIdx = 0;
  const ex = ms.slice(startIdx);
  const t0 = Date.parse(ex[0].machine.timestamp);
  const sec = (m) => Math.round((Date.parse(m.machine.timestamp) - t0) / 1000);

  // Dose / yield / ratio.
  const lastW = [...ex].reverse().find((m) => m.scale?.weight != null)?.scale.weight;
  const dose = ann.actualDoseWeight ?? ctx.targetDoseWeight ?? 0;
  const yld = ann.actualYield ?? lastW ?? 0;
  const ty = ctx.targetYield;
  const ratio = dose > 0 ? yld / dose : 0;
  const dur = sec(ex[ex.length - 1]);

  // Overall peaks across the extraction.
  let pp = -Infinity; let ppT = 0; let pf = -Infinity; let pfT = 0;
  for (const m of ex) {
    if (m.machine.pressure > pp) { pp = m.machine.pressure; ppT = sec(m); }
    if (m.machine.flow > pf) { pf = m.machine.flow; pfT = sec(m); }
  }

  const out = ['## Shot Summary', ''];
  let y = `- **Dose**: ${num(dose, 1)}g → **Yield**: ${num(yld, 1)}g`;
  if (ty != null) {
    const dev = yld - ty;
    y += ` (target ${num(ty, 0)}g, ${dev >= 0 ? '+' : ''}${num(dev, 1)}g)`;
  }
  if (ratio) y += ` ratio 1:${num(ratio, 1)}`;
  out.push(y);
  out.push(`- **Duration**: ${dur}s`);
  out.push(`- **Overall shot peaks**: pressure ${num(pp)} bar @${ppT}s, flow ${num(pf)} ml/s @${pfT}s`);
  out.push('', '## Phase Data', '');
  out.push('Each phase shows peak values with timing, then start, peak deviation from target, and end. Values: actual(target).', '');

  const row = (m, step) => {
    const mm = m.machine; const sc = m.scale || {}; const tt = step.temperature;
    return `${num(mm.pressure)}(${num(mm.targetPressure)})bar `
      + `${num(mm.flow)}(${num(mm.targetFlow)})ml/s `
      + `${num(mm.mixTemperature, 0)}(${tt == null ? '-' : num(tt, 0)})°C `
      + `${num(sc.weight, 1)}g`;
  };

  // Group consecutive samples by profile frame into phases.
  let i = 0;
  while (i < ex.length) {
    const frame = ex[i].machine.profileFrame;
    let j = i;
    while (j < ex.length && ex[j].machine.profileFrame === frame) j += 1;
    const seg = ex.slice(i, j);
    const step = steps[frame] || {};
    const name = step.name || `Frame ${frame}`;
    const control = step.pump === 'pressure' ? 'PRESSURE-CONTROLLED'
      : step.pump === 'flow' ? 'FLOW-CONTROLLED' : 'UNKNOWN';
    const pdur = sec(seg[seg.length - 1]) - sec(seg[0]);

    let sp = -Infinity; let spT = 0; let sf = -Infinity; let sfT = 0;
    for (const m of seg) {
      if (m.machine.pressure > sp) { sp = m.machine.pressure; spT = sec(m); }
      if (m.machine.flow > sf) { sf = m.machine.flow; sfT = sec(m); }
    }

    out.push(`### ${name} (${pdur}s) ${control}`);
    out.push(`- Peak within this phase only: pressure ${num(sp)} bar @${spT}s, flow ${num(sf)} ml/s @${sfT}s`);
    out.push(`- Start @${sec(seg[0])}s: ${row(seg[0], step)}`);
    out.push(`- End @${sec(seg[seg.length - 1])}s: ${row(seg[seg.length - 1], step)}`);
    out.push('');
    i = j;
  }

  return out.join('\n');
}
