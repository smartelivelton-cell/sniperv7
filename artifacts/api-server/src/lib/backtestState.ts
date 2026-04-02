const lowHoursMap = new Map<string, Set<number>>();

export function setLowAssertivityHours(symbol: string, hours: number[]): void {
  lowHoursMap.set(symbol.toUpperCase(), new Set(hours));
}

export function isLowAssertivityHour(symbol: string): boolean {
  const hours = lowHoursMap.get(symbol.toUpperCase());
  if (!hours || hours.size === 0) return false;
  const hourBr = parseInt(
    new Date().toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      hour12: false,
    }),
    10,
  );
  return hours.has(hourBr);
}
