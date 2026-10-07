/**
 * Minimal QR Code encoder (byte mode, error-correction level M, versions 1–13),
 * enough for otpauth:// provisioning URIs. Based on the QR spec (ISO/IEC 18004);
 * structure follows Project Nayuki's reference implementation.
 */

interface VersionSpec {
  ec: number; // EC codewords per block
  groups: [number, number][]; // [blockCount, dataCodewordsPerBlock]
  align: number[];
}

const VERSIONS: Record<number, VersionSpec> = {
  1: { ec: 10, groups: [[1, 16]], align: [] },
  2: { ec: 16, groups: [[1, 28]], align: [6, 18] },
  3: { ec: 26, groups: [[1, 44]], align: [6, 22] },
  4: { ec: 18, groups: [[2, 32]], align: [6, 26] },
  5: { ec: 24, groups: [[2, 43]], align: [6, 30] },
  6: { ec: 16, groups: [[4, 27]], align: [6, 34] },
  7: { ec: 18, groups: [[4, 31]], align: [6, 22, 38] },
  8: { ec: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42] },
  9: { ec: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46] },
  10: { ec: 26, groups: [[4, 43], [1, 44]], align: [6, 28, 50] },
  11: { ec: 30, groups: [[1, 50], [4, 51]], align: [6, 30, 54] },
  12: { ec: 22, groups: [[6, 36], [2, 37]], align: [6, 32, 58] },
  13: { ec: 22, groups: [[8, 37], [1, 38]], align: [6, 34, 62] },
};

function dataCapacity(v: number): number {
  return VERSIONS[v]!.groups.reduce((s, [n, d]) => s + n * d, 0);
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMul(coef, factor);
    });
  }
  return result;
}

const getBit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

export function encodeQr(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 0;
  for (let v = 1; v <= 13; v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCapacity(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error("Text too long for QR code");
  const spec = VERSIONS[version]!;
  const capacityBits = dataCapacity(version) * 8;

  // --- bit stream ---
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    data.push(b);
  }

  // --- blocks & interleave ---
  const divisor = rsDivisor(spec.ec);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let k = 0;
  for (const [count, len] of spec.groups) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(k, k + len);
      k += len;
      blocks.push({ data: d, ec: rsRemainder(d, divisor) });
    }
  }
  const codewords: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) codewords.push(b.data[i]!);
  for (let i = 0; i < spec.ec; i++) for (const b of blocks) codewords.push(b.ec[i]!);

  // --- matrix ---
  const size = version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const isFn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    isFn[y]![x] = true;
  };

  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const al = spec.align;
  for (let i = 0; i < al.length; i++)
    for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) setFn(al[i]! + dx, al[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

  const drawFormat = (mask: number) => {
    const fmt = (0 << 3) | mask; // ECC level M = 00
    let rem = fmt;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((fmt << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(fbits, i));
    setFn(8, 7, getBit(fbits, 6));
    setFn(8, 8, getBit(fbits, 7));
    setFn(7, 8, getBit(fbits, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(fbits, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(fbits, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(fbits, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0); // reserve
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, getBit(vbits, i));
      setFn(b, a, getBit(vbits, i));
    }
  }

  // data placement (zig-zag)
  let bi = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFn[y]![x] && bi < codewords.length * 8) {
          modules[y]![x] = getBit(codewords[bi >>> 3]!, 7 - (bi & 7));
          bi++;
        }
      }
  }

  const maskFn = (m: number, x: number, y: number): boolean => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (m: number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (!isFn[y]![x] && maskFn(m, x, y)) modules[y]![x] = !modules[y]![x];
  };

  const penalty = (): number => {
    let p = 0;
    const line = (get: (i: number, j: number) => boolean) => {
      for (let i = 0; i < size; i++) {
        let run = 1;
        for (let j = 1; j < size; j++) {
          if (get(i, j) === get(i, j - 1)) run++;
          else {
            if (run >= 5) p += run - 2;
            run = 1;
          }
        }
        if (run >= 5) p += run - 2;
        for (let j = 0; j + 10 < size; j++) {
          const seq = Array.from({ length: 11 }, (_, t) => (get(i, j + t) ? 1 : 0)).join("");
          if (seq === "10111010000" || seq === "00001011101") p += 40;
        }
      }
    };
    line((i, j) => modules[i]![j]!);
    line((i, j) => modules[j]![i]!);
    let dark = 0;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        if (modules[y]![x]) dark++;
        if (y + 1 < size && x + 1 < size) {
          const c = modules[y]![x];
          if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) p += 3;
        }
      }
    p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  };

  let best = 0;
  let bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m);
    drawFormat(m);
    const s = penalty();
    if (s < bestScore) {
      bestScore = s;
      best = m;
    }
    applyMask(m); // undo
  }
  applyMask(best);
  drawFormat(best);
  return modules;
}

/** SVG markup (with 4-module quiet zone). */
export function qrSvg(text: string, scale = 4): string {
  const m = encodeQr(text);
  const n = m.length + 8;
  let path = "";
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + 4},${y + 4}h1v1h-1z`;
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * scale}" height="${n * scale}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#181d26"/></svg>`;
}
