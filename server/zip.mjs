// 极简 zip 打包：只做 STORED（不压缩），无外部依赖，确定性输出。
//
// 用途：把一本学习的全部制品打包成一个 .zip 带走——浏览器/系统解压后直接双击 index.html
// 就能看（整本 JSON 备份要导入才能看，zip 是"可打开的 HTML 集合"）。
// 只写不读；zip 的正确性由 test/run.mjs §12l 用自带的迷你 zip 读取器逐字节验证
// （本地文件头 / 中央目录 / CRC32 全对得上）。
//
// 故意不做压缩：本地工具，制品以文本 HTML 为主，STORED 足够；少一个压缩实现就少一类
// 隐蔽 bug。时间戳固定（不用当前时间），同一输入永远产出同一字节——可复现、可测试。

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS 日期时间：固定 2026-01-01 00:00，避免"同一输入不同字节"。
const DOS_TIME = 0; // 0x0000 = 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // 2026-01-01

function dosEpoch(date) {
  void date;
  return { time: DOS_TIME, date: DOS_DATE };
}

/**
 * 把条目列表打包成 zip 字节。条目：{ name, data: Buffer|string }。
 * 文件名按 UTF-8 处理（置位通用标志 bit 11），条目按 name 排序保证确定性。
 * 同名条目只保留最后一个（manifest 里不该有重复，但防御一下）。
 */
export function buildZip(entries) {
  const unique = new Map();
  for (const e of entries) unique.set(e.name, e.data);
  const names = [...unique.keys()].sort();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const data = Buffer.isBuffer(unique.get(name)) ? unique.get(name) : Buffer.from(String(unique.get(name)), 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, date } = dosEpoch(null);
    // 通用标志 bit 11：文件名为 UTF-8（解压端不会把中文名读成乱码）
    const flags = 0x0800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    local.writeUInt16LE(20, 4); // 版本
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // 方法：STORED
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // 压缩后大小 = 原大小（STORED）
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra
    parts.push(local, nameBuf, data);
    const localEnd = offset + local.length + nameBuf.length + data.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    cd.writeUInt16LE(20, 4); // 制作版本
    cd.writeUInt16LE(20, 6); // 需要版本
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(0, 10); // STORED
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(0, 38); // 外部属性
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cd, nameBuf);

    offset = localEnd;
  }

  const cdStart = offset;
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  end.writeUInt16LE(0, 4); // 本盘
  end.writeUInt16LE(0, 6); // 中央目录起始盘
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(cdStart, 16);
  end.writeUInt16LE(0, 20); // comment

  return Buffer.concat([...parts, centralBuf, end]);
}
