// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/keycode-info/logic.ts. See THIRD_PARTY.md.
/**
 * Describe a keyboard event's identifying fields. Pure and local — takes a
 * KeyboardEvent-like object so it's testable without the DOM.
 */

export const LOCATION_NAMES = ['Standard', 'Left', 'Right', 'Numpad'] as const;

export interface KeyboardEventLike {
  key: string;
  code: string;
  keyCode: number;
  which?: number;
  location: number;
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface KeyInfo {
  key: string;
  code: string;
  keyCode: number;
  which: number;
  location: number;
  locationName: string;
  modifiers: string[];
}

export function describeKeyEvent(e: KeyboardEventLike): KeyInfo {
  const modifiers: string[] = [];
  if (e.ctrlKey) modifiers.push('Ctrl');
  if (e.altKey) modifiers.push('Alt');
  if (e.shiftKey) modifiers.push('Shift');
  if (e.metaKey) modifiers.push('Meta');

  return {
    key: e.key === ' ' ? 'Space' : e.key,
    code: e.code,
    keyCode: e.keyCode,
    which: e.which ?? e.keyCode,
    location: e.location,
    locationName: LOCATION_NAMES[e.location] ?? String(e.location),
    modifiers,
  };
}
