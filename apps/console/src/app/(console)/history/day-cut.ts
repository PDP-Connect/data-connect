// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
export const DAY_COOKIE = "dc-day-offset";
export function personOffset(value: string | undefined, serverOffset = -new Date().getTimezoneOffset()): number {
  const offset = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isInteger(offset) && Math.abs(offset) <= 840 ? offset : serverOffset;
}
export function personDay(at: string | number, offset: number): string {
  return new Date((typeof at === "number" ? at : Date.parse(at)) + offset * 60_000).toISOString().slice(0,10);
}
export function dayLabel(day: string, offset: number, now = Date.now()): string {
  if (day === personDay(now, offset)) return "Today";
  if (day === personDay(now - 86_400_000, offset)) return "Yesterday";
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
export function clockLabel(at: string, offset: number): string {
  return new Date(Date.parse(at) + offset * 60_000).toISOString().slice(11,16);
}
export function historyTime(at: string | null, offset: number, now = Date.now()): string {
  if (!at) return "";
  if (personDay(at, offset) === personDay(now, offset)) {
    const minutes = Math.max(0, Math.floor((now-Date.parse(at))/60_000));
    return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes} minute${minutes === 1 ? "" : "s"} ago` : clockLabel(at,offset);
  }
  return clockLabel(at, offset);
}
export function historyRange(offset: number, now = Date.now()) {
  return { first: "1970-01-01", last: personDay(now,offset), offset };
}
export function visibleDays(rows: { day: string }[], count: number): string[] {
  return [...new Set(rows.map(row => row.day))].sort().reverse().slice(0,count);
}
export function historyDayCount(value?: string): number {
  const count = Number(value);
  return Number.isInteger(count) && count >= 7 && count <= 10000 ? count : 7;
}
export function historyHref(path: string, params: Record<string,string | undefined>, patch: Record<string,string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key,value] of Object.entries({ ...params, ...patch })) if (value) query.set(key,value);
  return `${path}${query.size ? `?${query}` : ""}`;
}

export function sentenceDayLabel(day: string, offset: number): string {
  const label = dayLabel(day,offset);
  return label === "Today" || label === "Yesterday" ? label.toLowerCase() : label;
}
export function startedAgo(at: string, now = Date.now()): string {
  const minutes = Math.max(0,Math.floor((now-Date.parse(at))/60_000));
  if (minutes < 1) return "a few seconds ago";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes/60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours/24); return `${days} day${days === 1 ? "" : "s"} ago`;
}
