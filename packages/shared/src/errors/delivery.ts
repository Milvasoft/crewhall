/** Delivery (e-mail and push providers) error codes; translations in packages/i18n/src/locales/{tr,en}/errors/delivery.json. */
export const DELIVERY_ERROR_CODES = [
  'delivery_not_configured',
  'delivery_no_device',
  'delivery_unauthorized',
  'delivery_rate_limited',
  'delivery_rejected',
  'delivery_provider_error',
] as const;

export const DELIVERY_ERROR_STATUS: Record<(typeof DELIVERY_ERROR_CODES)[number], number> = {
  delivery_not_configured: 409,
  delivery_no_device: 409,
  delivery_unauthorized: 502,
  delivery_rate_limited: 429,
  delivery_rejected: 422,
  delivery_provider_error: 502,
};
