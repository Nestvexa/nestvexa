/** True when the text contains C0 control characters or DEL (header/log injection vectors). */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Component names: 1-256 characters without control characters. */
export function validComponent(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !hasControlCharacter(value);
}
