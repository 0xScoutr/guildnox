/**
 * Dias no horário de Brasília. O servidor (Railway) roda em UTC, então "hoje" e
 * "meia-noite" calculados com setHours() caíam 3 horas fora: o boss das 22:00 de
 * um dia contava no dia seguinte.
 */

const TZ = "America/Sao_Paulo";

function partsIn(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Quantos minutos Brasília está à frente (negativo: atrás) do UTC naquele instante. */
function offsetMinutes(date) {
  const p = partsIn(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** Instante da meia-noite de Brasília do dia (ano, mês 1-12, dia). */
export function brtStartOfDay(year, month, day) {
  const guess = Date.UTC(year, month - 1, day);
  return new Date(guess - offsetMinutes(new Date(guess)) * 60_000);
}

/** Último milissegundo do dia em Brasília. */
export function brtEndOfDay(year, month, day) {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return new Date(brtStartOfDay(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()).getTime() - 1);
}

/** Dia de hoje em Brasília, mais ou menos `days`. */
export function brtToday(days = 0) {
  const p = partsIn(new Date());
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** "AAAA-MM-DD" do dia em Brasília. */
export function brtDateString({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
