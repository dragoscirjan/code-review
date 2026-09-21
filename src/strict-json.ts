export type StrictJsonErrorCode = 'duplicate-property' | 'invalid-json' | 'nesting-too-deep' | 'oversized-json';

export class StrictJsonError extends Error {
  constructor(
    readonly code: StrictJsonErrorCode,
    readonly offset: number,
  ) {
    super(`Strict JSON rejected: ${code}`);
    this.name = 'StrictJsonError';
  }
}

function fail(code: StrictJsonErrorCode, offset: number): never {
  throw new StrictJsonError(code, offset);
}

/** Parses one bounded JSON document while rejecting duplicate object properties before JSON.parse can erase them. */
export function parseStrictJson(raw: string, maximumBytes: number, maximumDepth = 32): unknown {
  if (Buffer.byteLength(raw, 'utf8') > maximumBytes) fail('oversized-json', 0);
  let offset = 0;

  function whitespace(): void {
    while (/^[\t\n\r ]$/u.test(raw[offset] ?? '')) offset += 1;
  }

  function string(): string {
    const start = offset;
    offset += 1;
    while (offset < raw.length) {
      const character = raw[offset];
      if (character === '"') {
        offset += 1;
        try {
          return JSON.parse(raw.slice(start, offset)) as string;
        } catch {
          return fail('invalid-json', start);
        }
      }
      if (character === '\\') {
        offset += 1;
        const escape = raw[offset];
        if (escape === 'u') {
          if (!/^[\da-fA-F]{4}$/u.test(raw.slice(offset + 1, offset + 5))) fail('invalid-json', offset);
          offset += 5;
          continue;
        }
        if (!escape || !'"\\/bfnrt'.includes(escape)) fail('invalid-json', offset);
        offset += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) fail('invalid-json', offset);
      offset += 1;
    }
    return fail('invalid-json', start);
  }

  function number(): void {
    const start = offset;
    if (raw[offset] === '-') offset += 1;
    if (raw[offset] === '0') offset += 1;
    else {
      const first = raw[offset];
      if (first === undefined || first < '1' || first > '9') fail('invalid-json', start);
      do offset += 1;
      while ((raw[offset] ?? '') >= '0' && (raw[offset] ?? '') <= '9');
    }
    if (raw[offset] === '.') {
      offset += 1;
      const fractionStart = offset;
      while ((raw[offset] ?? '') >= '0' && (raw[offset] ?? '') <= '9') offset += 1;
      if (offset === fractionStart) fail('invalid-json', offset);
    }
    if (raw[offset] === 'e' || raw[offset] === 'E') {
      offset += 1;
      if (raw[offset] === '+' || raw[offset] === '-') offset += 1;
      const exponentStart = offset;
      while ((raw[offset] ?? '') >= '0' && (raw[offset] ?? '') <= '9') offset += 1;
      if (offset === exponentStart) fail('invalid-json', offset);
    }
  }

  function value(depth: number): void {
    const character = raw[offset];
    if (character === '{') {
      if (depth >= maximumDepth) fail('nesting-too-deep', offset);
      object(depth + 1);
    } else if (character === '[') {
      if (depth >= maximumDepth) fail('nesting-too-deep', offset);
      array(depth + 1);
    } else if (character === '"') string();
    else if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) number();
    else if (raw.startsWith('true', offset)) offset += 4;
    else if (raw.startsWith('false', offset)) offset += 5;
    else if (raw.startsWith('null', offset)) offset += 4;
    else fail('invalid-json', offset);
  }

  function object(depth: number): void {
    offset += 1;
    whitespace();
    if (raw[offset] === '}') {
      offset += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      if (raw[offset] !== '"') fail('invalid-json', offset);
      const keyOffset = offset;
      const key = string();
      if (keys.has(key)) fail('duplicate-property', keyOffset);
      keys.add(key);
      whitespace();
      if (raw[offset] !== ':') fail('invalid-json', offset);
      offset += 1;
      whitespace();
      value(depth);
      whitespace();
      if (raw[offset] === '}') {
        offset += 1;
        return;
      }
      if (raw[offset] !== ',') fail('invalid-json', offset);
      offset += 1;
      whitespace();
    }
  }

  function array(depth: number): void {
    offset += 1;
    whitespace();
    if (raw[offset] === ']') {
      offset += 1;
      return;
    }
    while (true) {
      value(depth);
      whitespace();
      if (raw[offset] === ']') {
        offset += 1;
        return;
      }
      if (raw[offset] !== ',') fail('invalid-json', offset);
      offset += 1;
      whitespace();
    }
  }

  whitespace();
  value(0);
  whitespace();
  if (offset !== raw.length) fail('invalid-json', offset);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fail('invalid-json', offset);
  }
}
