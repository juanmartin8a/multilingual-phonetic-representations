export function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

// Integer nano-USD avoids accumulation and budget-comparison rounding errors.
export function usd(value) {
  if (!/^\d+(\.\d{1,9})?$/.test(String(value))) throw new Error('Invalid USD amount');
  const [whole, fraction = ''] = String(value).split('.');
  return integer(Number(whole) * 1e9 + Number(fraction.padEnd(9, '0')), 'USD', 0, 1e15);
}

export function rate(value, name) {
  if (!/^\d+(\.\d{1,3})?$/.test(String(value))) throw new Error(`${name}: use up to 3 decimal places`);
  const [whole, fraction = ''] = String(value).split('.');
  return integer(Number(whole) * 1000 + Number(fraction.padEnd(3, '0')), name, 0, 1e9);
}

