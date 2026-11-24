export const defaults = Object.freeze({ interval: 30, keepAwake: false });
export const maxInterval = 86_400;
export const powerPermission = { permissions: ['power'] };

export function validateInterval(value) {
  if (!Number.isInteger(value) || value < 1 || value > maxInterval) {
    throw new Error('Enter a whole number from 1 to 86,400 seconds.');
  }
  return value;
}
