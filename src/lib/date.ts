const TIME_ZONE = 'Asia/Shanghai';

type DatePart = 'year' | 'month' | 'day' | 'weekday' | 'hour' | 'minute' | 'second';

function partsOf(date: Date, options: Intl.DateTimeFormatOptions): Record<DatePart, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    ...options,
  }).formatToParts(date);
  const record = {} as Record<DatePart, string>;
  for (const part of parts) {
    if (part.type !== 'literal') record[part.type as DatePart] = part.value;
  }
  return record;
}

export function beijingParts(date: Date) {
  const p = partsOf(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

export function beijingYear(date: Date): string {
  return partsOf(date, { year: 'numeric' }).year;
}

export function beijingDay(date: Date): string {
  return partsOf(date, { day: '2-digit' }).day;
}

export function beijingYearMonth(date: Date): string {
  const p = partsOf(date, { year: 'numeric', month: '2-digit' });
  return `${p.year}.${p.month}`;
}

export function beijingMonthDay(date: Date): string {
  const p = partsOf(date, { month: '2-digit', day: '2-digit' });
  return `${p.month}.${p.day}`;
}

export function beijingDateDot(date: Date): string {
  const p = partsOf(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}.${p.month}.${p.day}`;
}

export function beijingDateCn(date: Date, style: 'long' | 'short' = 'long'): string {
  const p = partsOf(date, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return style === 'long'
    ? `${p.year}年${Number(p.month)}月${Number(p.day)}日`
    : `${Number(p.month)}月${Number(p.day)}日`;
}

export function beijingWeekday(date: Date): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: TIME_ZONE, weekday: 'long' }).format(date);
}

export function beijingTime(date: Date): string {
  const p = partsOf(date, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${p.hour}:${p.minute}`;
}

export function beijingIso(date: Date): string {
  const p = beijingParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

export function isSameBeijingDay(a: Date, b: Date): boolean {
  const pa = partsOf(a, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const pb = partsOf(b, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}
