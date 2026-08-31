export function latin1WireByteLength(value: string): number | null {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0xff) return null;
  }
  return value.length;
}
