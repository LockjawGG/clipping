/**
 * Freestanding text-element roles. Isomorphic — no server imports — so client
 * editor components can use it without pulling in the overlay service.
 */
export const TEXT_OVERLAY_ROLES = ["title", "lowerThird", "callout", "social"] as const;
export type TextOverlayRole = (typeof TEXT_OVERLAY_ROLES)[number];
