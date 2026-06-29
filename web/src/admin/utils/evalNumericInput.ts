/**
 * Evaluate a numeric field value that may be a plain number or a simple
 * arithmetic expression using + - * / with standard precedence.
 * Returns null when the input is empty or invalid.
 */
export function evalNumericInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }

  const compact = trimmed.replace(/\s+/g, '');
  if (!/^[\d+\-*/().]+$/.test(compact)) return null;

  try {
    const tokens = tokenize(compact);
    const value = parseExpression(tokens);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'op'; value: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', value: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }

    if (!/\d|\./.test(ch)) throw new Error('invalid token');

    let j = i + 1;
    while (j < input.length && /[\d.]/.test(input[j])) j += 1;
    const num = Number(input.slice(i, j));
    if (!Number.isFinite(num)) throw new Error('invalid number');
    tokens.push({ kind: 'num', value: num });
    i = j;
  }

  return tokens;
}

function parseExpression(tokens: Token[]): number {
  let i = 0;

  function parseAddSub(): number {
    let value = parseMulDiv();
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.kind !== 'op' || (tok.value !== '+' && tok.value !== '-')) break;
      i += 1;
      const rhs = parseMulDiv();
      value = tok.value === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseMulDiv(): number {
    let value = parseUnary();
    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.kind !== 'op' || (tok.value !== '*' && tok.value !== '/')) break;
      i += 1;
      const rhs = parseUnary();
      if (tok.value === '/' && rhs === 0) throw new Error('divide by zero');
      value = tok.value === '*' ? value * rhs : value / rhs;
    }
    return value;
  }

  function parseUnary(): number {
    if (i < tokens.length) {
      const tok = tokens[i];
      if (tok.kind === 'op' && tok.value === '-') {
        i += 1;
        return -parseUnary();
      }
      if (tok.kind === 'op' && tok.value === '+') {
        i += 1;
      }
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    if (i >= tokens.length) throw new Error('unexpected end');

    const tok = tokens[i];
    if (tok.kind === 'num') {
      i += 1;
      return tok.value;
    }

    if (tok.kind === 'lparen') {
      i += 1;
      const value = parseAddSub();
      if (i >= tokens.length || tokens[i].kind !== 'rparen') throw new Error('missing )');
      i += 1;
      return value;
    }

    throw new Error('unexpected token');
  }

  const result = parseAddSub();
  if (i !== tokens.length) throw new Error('trailing tokens');
  return result;
}
