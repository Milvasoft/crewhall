// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/phone-parser/logic.ts. See THIRD_PARTY.md.
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Parse and format phone numbers with libphonenumber-js. Pure and local.
 */

export interface PhoneField {
  label: string;
  value: string;
}

export interface PhoneResult {
  valid: boolean;
  possible: boolean;
  fields: PhoneField[];
}

export function parsePhone(input: string, defaultCountry?: string): PhoneResult {
  const phone = parsePhoneNumberFromString(
    input.trim(),
    defaultCountry ? (defaultCountry as CountryCode) : undefined,
  );

  if (!phone) {
    return { valid: false, possible: false, fields: [] };
  }

  return {
    valid: phone.isValid(),
    possible: phone.isPossible(),
    fields: [
      { label: 'E.164', value: phone.number },
      { label: 'International', value: phone.formatInternational() },
      { label: 'National', value: phone.formatNational() },
      { label: 'Country', value: phone.country ?? 'Unknown' },
      { label: 'Calling code', value: `+${phone.countryCallingCode}` },
      { label: 'National number', value: phone.nationalNumber },
      { label: 'Type', value: phone.getType() ?? 'Unknown' },
      { label: 'URI', value: phone.getURI() },
    ],
  };
}
