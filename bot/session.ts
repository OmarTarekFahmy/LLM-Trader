import { DateTime } from "luxon";

export const CAIRO_TZ = "Africa/Cairo";

// EGX regular session: Sunday-Thursday, 10:00-14:15 Cairo local time.
const SESSION_OPEN = { hour: 10, minute: 0 };
const SESSION_CLOSE = { hour: 14, minute: 15 };
// End-of-day wrap-up window (mark-to-market, no trade decision).
const EOD_START = { hour: 14, minute: 20 };
const EOD_END = { hour: 15, minute: 30 };

export interface SessionCheck {
  now: DateTime;
  label: string;
  isTradingDay: boolean;
  isOpen: boolean;
  isEodWindow: boolean;
}

export function checkSession(at: DateTime = DateTime.now()): SessionCheck {
  const now = at.setZone(CAIRO_TZ);
  // luxon weekday: 1=Mon .. 7=Sun. EGX trades Sun-Thu => 7,1,2,3,4.
  const isTradingDay = now.weekday === 7 || now.weekday <= 4;

  const minutes = now.hour * 60 + now.minute;
  const openM = SESSION_OPEN.hour * 60 + SESSION_OPEN.minute;
  const closeM = SESSION_CLOSE.hour * 60 + SESSION_CLOSE.minute;
  const eodStartM = EOD_START.hour * 60 + EOD_START.minute;
  const eodEndM = EOD_END.hour * 60 + EOD_END.minute;

  const isOpen = isTradingDay && minutes >= openM && minutes <= closeM;
  const isEodWindow = isTradingDay && minutes >= eodStartM && minutes <= eodEndM;

  let label: string;
  if (!isTradingDay) label = "market closed (weekend)";
  else if (isOpen) label = "market open";
  else if (isEodWindow) label = "end-of-day window";
  else if (minutes < openM) label = "market closed (pre-open)";
  else label = "market closed (after hours)";

  return { now, label, isTradingDay, isOpen, isEodWindow };
}

export function cairoNowIso(): string {
  return DateTime.now().setZone(CAIRO_TZ).toISO() ?? new Date().toISOString();
}

/**
 * Count EGX trading days (Sun-Thu) strictly between two instants, inclusive of
 * neither endpoint's partial day beyond calendar boundaries. Used for minHoldingDays.
 */
export function tradingDaysBetween(fromIso: string, toIso: string): number {
  let cursor = DateTime.fromISO(fromIso).setZone(CAIRO_TZ).startOf("day");
  const end = DateTime.fromISO(toIso).setZone(CAIRO_TZ).startOf("day");
  if (!cursor.isValid || !end.isValid || end <= cursor) return 0;
  let count = 0;
  cursor = cursor.plus({ days: 1 });
  while (cursor <= end) {
    if (cursor.weekday === 7 || cursor.weekday <= 4) count += 1;
    cursor = cursor.plus({ days: 1 });
  }
  return count;
}
