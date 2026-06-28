// cron.ts — pure cron "next run" calculator.
//
// No Date.now(), no network, no I/O. The only input besides the cron expression
// is `from` (passed in), so the function is fully deterministic and testable.
//
// Supports standard 5-field cron: minute hour day-of-month month day-of-week.
// Also supports an OPTIONAL 6-field form (seconds first) for fast local testing;
// the engine's setSchedule validates 5-field only (cron-validator@1.3.1 without
// { seconds: true }), so 6-field is a local convenience — ON_ENABLE will never
// emit one.
//
// Field syntax: '*', lists 'a,b,c', ranges 'a-b', steps '*/n' and 'a-b/n'.
// Day-of-week: 0=Sun..6=Sat (7 also accepted as Sun).
//
// Standard Vixie semantics: when BOTH day-of-month and day-of-week are
// restricted (not '*'), a date matches if EITHER field matches; when only one
// is restricted, that one governs; when both are '*', every day matches.

export type CronField = {
  set: Set<number>;
  isFull: boolean;
};

function parseField(raw: string, min: number, max: number): CronField {
  const set = new Set<number>();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (p === '*') {
      for (let v = min; v <= max; v++) set.add(v);
      continue;
    }
    const slash = p.split('/');
    const step = slash.length === 2 ? parseInt(slash[1], 10) : 1;
    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`Invalid step in cron field "${p}"`);
    }
    const rangePart = slash[0];
    let lo: number, hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = parseInt(rangePart, 10);
      hi = lo;
    }
    if (
      !Number.isFinite(lo) ||
      !Number.isFinite(hi) ||
      lo < min ||
      hi > max ||
      lo > hi
    ) {
      throw new Error(
        `Invalid range "${rangePart}" in cron field "${raw}" (min=${min} max=${max})`,
      );
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  let isFull = true;
  for (let v = min; v <= max; v++) {
    if (!set.has(v)) {
      isFull = false;
      break;
    }
  }
  return { set, isFull };
}

type ParsedCron = {
  hasSeconds: boolean;
  sec: CronField;
  min: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  let sec: CronField | undefined;
  let idx = 0;
  if (parts.length === 6) {
    sec = parseField(parts[0], 0, 59);
    idx = 1;
  } else if (parts.length === 5) {
    idx = 0;
  } else {
    throw new Error(
      `Invalid cron "${expr}": expected 5 or 6 fields, got ${parts.length}`,
    );
  }
  const min = parseField(parts[idx], 0, 59);
  const hour = parseField(parts[idx + 1], 0, 23);
  const dom = parseField(parts[idx + 2], 1, 31);
  const month = parseField(parts[idx + 3], 1, 12);
  // dow: parse 0..7 then normalize 7 -> 0 and recompute isFull against 0..6.
  let dow = parseField(parts[idx + 4], 0, 7);
  if (dow.set.has(7)) {
    const arr = [...dow.set].map((v) => (v === 7 ? 0 : v));
    dow = { set: new Set(arr), isFull: false };
  }
  let dowFull = true;
  for (let v = 0; v <= 6; v++) {
    if (!dow.set.has(v)) {
      dowFull = false;
      break;
    }
  }
  dow = { set: dow.set, isFull: dowFull };
  return {
    hasSeconds: !!sec,
    sec: sec ?? { set: new Set([0]), isFull: true },
    min,
    hour,
    dom,
    month,
    dow,
  };
}

function matches(d: Date, f: ParsedCron): boolean {
  if (f.hasSeconds && !f.sec.set.has(d.getSeconds())) return false;
  if (!f.min.set.has(d.getMinutes())) return false;
  if (!f.hour.set.has(d.getHours())) return false;
  if (!f.month.set.has(d.getMonth() + 1)) return false;
  const domMatch = f.dom.set.has(d.getDate());
  const dowMatch = f.dow.set.has(d.getDay());
  const dayOk =
    !f.dom.isFull && !f.dow.isFull ? domMatch || dowMatch : domMatch && dowMatch;
  return dayOk;
}

/**
 * Returns the next firing time STRICTLY AFTER `from` for the given cron
 * expression. Pure: no Date.now(), no side effects.
 *
 * @param cronExpression 5-field (min h dom mon dow) or 6-field (sec min h dom mon dow).
 * @param from reference instant; the result is the first match strictly after it.
 */
export function nextRun(cronExpression: string, from: Date): Date {
  const f = parseCron(cronExpression);
  const d = new Date(from.getTime());
  d.setMilliseconds(0);
  if (f.hasSeconds) {
    d.setSeconds(d.getSeconds() + 1);
  } else {
    d.setSeconds(0);
    d.setMinutes(d.getMinutes() + 1);
  }
  const CAP = 1_000_000;
  for (let i = 0; i < CAP; i++) {
    if (!f.month.set.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1);
      d.setDate(1);
      d.setHours(0);
      d.setMinutes(0);
      d.setSeconds(0);
      d.setMilliseconds(0);
      continue;
    }
    const domMatch = f.dom.set.has(d.getDate());
    const dowMatch = f.dow.set.has(d.getDay());
    const dayOk =
      !f.dom.isFull && !f.dow.isFull ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0);
      d.setMinutes(0);
      d.setSeconds(0);
      d.setMilliseconds(0);
      continue;
    }
    if (!f.hour.set.has(d.getHours())) {
      d.setHours(d.getHours() + 1);
      d.setMinutes(0);
      d.setSeconds(0);
      d.setMilliseconds(0);
      continue;
    }
    if (!f.min.set.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
      d.setSeconds(0);
      d.setMilliseconds(0);
      continue;
    }
    if (f.hasSeconds && !f.sec.set.has(d.getSeconds())) {
      d.setSeconds(d.getSeconds() + 1);
      d.setMilliseconds(0);
      continue;
    }
    return new Date(d.getTime());
  }
  throw new Error(
    `nextRun: no match within ${CAP} iterations for "${cronExpression}"`,
  );
}

// Exposed for callers that want to validate shape without computing a run.
export function isValidCronShape(cronExpression: string): boolean {
  try {
    parseCron(cronExpression);
    return true;
  } catch {
    return false;
  }
}