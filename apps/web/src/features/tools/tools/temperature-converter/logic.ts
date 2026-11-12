// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/temperature-converter/logic.ts. See THIRD_PARTY.md.
/**
 * Temperature conversion via a canonical Celsius value. Pure and local.
 */

export type TempUnit = 'c' | 'f' | 'k' | 'r'; // Celsius, Fahrenheit, Kelvin, Rankine

export const TEMP_UNITS: { id: TempUnit; label: string; symbol: string }[] = [
  { id: 'c', label: 'Celsius', symbol: '°C' },
  { id: 'f', label: 'Fahrenheit', symbol: '°F' },
  { id: 'k', label: 'Kelvin', symbol: 'K' },
  { id: 'r', label: 'Rankine', symbol: '°R' },
];

export function toCelsius(value: number, from: TempUnit): number {
  switch (from) {
    case 'c':
      return value;
    case 'f':
      return (value - 32) * (5 / 9);
    case 'k':
      return value - 273.15;
    case 'r':
      return (value - 491.67) * (5 / 9);
  }
}

export function fromCelsius(celsius: number, to: TempUnit): number {
  switch (to) {
    case 'c':
      return celsius;
    case 'f':
      return celsius * (9 / 5) + 32;
    case 'k':
      return celsius + 273.15;
    case 'r':
      return (celsius + 273.15) * (9 / 5);
  }
}

export function convertTemp(value: number, from: TempUnit, to: TempUnit): number {
  return fromCelsius(toCelsius(value, from), to);
}

export interface TempRow {
  unit: TempUnit;
  label: string;
  symbol: string;
  value: number;
}

export function convertAllTemps(value: number, from: TempUnit): TempRow[] {
  const celsius = toCelsius(value, from);
  return TEMP_UNITS.map((u) => ({
    unit: u.id,
    label: u.label,
    symbol: u.symbol,
    value: Math.round(fromCelsius(celsius, u.id) * 100) / 100,
  }));
}
