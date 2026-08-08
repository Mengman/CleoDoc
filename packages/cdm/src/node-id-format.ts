export const CDM_NODE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const CDM_NODE_ID_LENGTH = 10;
export const CDM_NODE_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{10}$/;

export function isCdmNodeId(value: string): boolean {
  return CDM_NODE_ID_PATTERN.test(value);
}
