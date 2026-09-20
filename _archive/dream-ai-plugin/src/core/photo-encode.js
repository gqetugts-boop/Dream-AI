/*
 * core/photo-encode.js — 无依赖图像编码
 *
 * 职责：
 *   - 把 RGBA/RGB 原始像素编码为 PNG（含 sRGB 声明块，避免宿主按未标记处理导致偏色）；
 *   - Baseline JPEG 编码（写回大图时可减小体积）；
 *   - 解码 data URL 为像素缓冲区；
 *   - 纯 JS 最近邻/双线性缩放与像素重排。
 * 边界：不访问 Photoshop、不访问网络；所有函数纯输入纯输出，可在 Node 下直接测试。
 */
(function (global) {
    'use strict';

    var DreamAI = global.DreamAI = global.DreamAI || {};
    if (DreamAI.PhotoEncode) return;

    var util = DreamAI.util;

    /* ============================================================
     * CRC32（PNG 块校验）
     * ============================================================ */
    var CRC_TABLE = (function () {
        var table = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) {
            c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        }
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /* ============================================================
     * DEFLATE：固定 Huffman 块 + 哈希链 LZ77
     *
     * PNG 用 zlib 容器（0x78 0x01 + deflate + adler32）。
     * 固定 Huffman 表由 RFC1951 规定，不需要写入码表，实现简单且体积可接受。
     * ============================================================ */

    var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
        35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
        3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
        257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
        7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

    /**
     * 位写入器。
     *
     * 语义：value 表示一段**比特序列**，序列第 0 位是 value 的 bit0，
     * 追加到比特流末尾；字节内按 bit0 → bit7 依次填充，写满输出。
     *
     * 这套约定是按 zlib 逐字节反推的，配合关系如下：
     *   - 头部 bfinal/btype：序列 (1,1,0)，即传 value = 0b011
     *   - Huffman 码：规范按 MSB-first 排列，故先 reverseBits 再传入
     *   - 长度额外位：规范按 LSB-first 排列，直接传原值
     *   - 距离额外位：与 Huffman 码一致，先 reverseBits 再传入
     * 码字与额外数据位序不同是 DEFLATE 规范本来的要求，不是笔误。
     */
    function BitWriter() {
        this.bytes = [];
        this.bitBuffer = 0;
        this.bitCount = 0;
    }
    BitWriter.prototype.writeBits = function (value, count) {
        for (var i = 0; i < count; i++) {
            this.bitBuffer |= ((value >>> i) & 1) << this.bitCount;
            this.bitCount++;
            if (this.bitCount === 8) {
                this.bytes.push(this.bitBuffer & 0xFF);
                this.bitBuffer = 0;
                this.bitCount = 0;
            }
        }
    };
    BitWriter.prototype.flush = function () {
        if (this.bitCount > 0) {
            this.bytes.push(this.bitBuffer & 0xFF);
            this.bitBuffer = 0;
            this.bitCount = 0;
        }
    };

    /**
     * 固定 Huffman 码的位序镜像。
     *
     * 位写入器把"第 1 个比特"放进字节的 bit0；固定码表里 8 位/9 位码属于
     * "低位有意义"的一类，必须先把码值按位颠倒再写入，zlib 才能正确解出。
     * 7 位码（256-279）不可颠倒——实测颠倒会让长度码整体错位、比特流截断。
     */
    function reverseBits(value, count) {
        var out = 0;
        for (var i = 0; i < count; i++) out = (out << 1) | ((value >>> i) & 1);
        return out;
    }

    /**
     * 固定 Huffman 字面量/长度码。
     *
     * 码长表（RFC1951 3.2.6）：
     *   0-143   → 8 位  00110000..10111111
     *   144-255 → 9 位  110010000..111111111
     *   256-279 → 7 位  0000000..0010111   （不镜像）
     *   280-287 → 8 位  11000000..11000111
     */
    function writeFixedLiteral(writer, symbol) {
        var code;
        var length;
        if (symbol <= 143) { length = 8; code = 0x30 + symbol; }
        else if (symbol <= 255) { length = 9; code = 0x190 + (symbol - 144); }
        else if (symbol <= 279) { length = 7; code = symbol - 256; }
        else { length = 8; code = 0xC0 + (symbol - 280); }
        // Huffman 码规范 MSB-first，写入器是序列低位在前，故统一镜像
        writer.writeBits(reverseBits(code, length), length);
    }

    /** 固定距离码：0-29 统一 5 位，与 8/9 位码一样需要镜像 */
    function writeFixedDistance(writer, symbol) {
        writer.writeBits(reverseBits(symbol, 5), 5);
    }

    /**
     * 匹配长度 → 长度符号（0-28）。
     * 表按升序排列，必须从前往后找"最后一个不超过 length 的档位"；
     * 从后往前扫会命中最高档，导致额外位数写错、比特流截断。
     */
    function lengthSymbol(length) {
        for (var i = LENGTH_BASE.length - 1; i > 0; i--) {
            if (length >= LENGTH_BASE[i]) return i;
        }
        return 0;
    }

    /** 距离 → 距离符号（0-29），同样按升序取最后一个不超过 distance 的档位 */
    function distSymbol(distance) {
        for (var i = DIST_BASE.length - 1; i > 0; i--) {
            if (distance >= DIST_BASE[i]) return i;
        }
        return 0;
    }

    /**
     * 用固定 Huffman 表压缩字节流。
     * @param {Uint8Array} input
     * @param {number} [level] 0 = 只存不压（store 块），1-3 = LZ77 匹配强度
     */
    /* ------------------------------------------------------------
     * LZ77 分词
     *
     * 独立成一步，先产出 token 列表（'l' 字面量 / 'm' 匹配），再交给
     * writeFixedBlock 逐条写入比特流。分开的好处是分词错误与位写入错误
     * 可以分别定位，读取端也能直接复现同一份 token 做比对。
     *
     * 匹配策略：哈希链表 + 最大链长限制（对应 level），窗口 32KB。
     * bestLength 达到 258 时立即停止搜索；下限 3 字节，否则退化为字面量。
     * ------------------------------------------------------------ */
    function tokenize(input, level) {
        var strategy = util.clamp(level, 1, 3, 2);
        var maxChain = strategy === 1 ? 8 : (strategy === 2 ? 32 : 128);
        var windowSize = 1 << 15;
        var head = new Int32Array(1 << 15);
        var prev = new Int32Array(windowSize);
        var tokens = [];
        var i;
        for (i = 0; i < head.length; i++) head[i] = -1;
        for (i = 0; i < prev.length; i++) prev[i] = -1;

        function hashAt(position) {
            if (position + 2 >= input.length) return -1;
            var value = (input[position] << 16) | (input[position + 1] << 8) | input[position + 2];
            return (value * 2654435761) >>> 17;
        }

        function insert(position) {
            var slot = hashAt(position);
            if (slot < 0) return;
            prev[position & (windowSize - 1)] = head[slot];
            head[slot] = position;
        }

        var index = 0;
        while (index < input.length) {
            /*
             * 匹配长度上限必须同时受"已输出字节数"约束。
             *
             * DEFLATE 允许 l > d 的重复匹配（RLE 就靠它），解码端会边复制边读取，
             * 因此 l 可以超过剩余输入，但**不能**超过当前已解码的历史长度：
             * 匹配开始时刻解码器手上只有 index 个字节，l > index 时后半段无从取值。
             * 之前只按剩余输入裁剪，产出的 token 让 zlib 报
             * "invalid distance too far back" / "unexpected end of file"。
             */
            var limit = Math.min(258, input.length - index, index);
            var bestLength = 0;
            var bestDistance = 0;
            if (limit >= 3) {
                var slot = hashAt(index);
                if (slot >= 0) {
                    var candidate = head[slot];
                    var chain = 0;
                    while (candidate >= 0 && chain < maxChain) {
                        chain++;
                        var distance = index - candidate;
                        if (distance > 32768) break;
                        var length = 0;
                        while (length < limit && input[candidate + length] === input[index + length]) length++;
                        // 注意：候选位置可能落在本次匹配区间内部（自重叠匹配），
                        // 这里比较的是输入数组本身，语义与解码端逐字节复制一致。
                        if (length > bestLength) {
                            bestLength = length;
                            bestDistance = distance;
                            if (length >= limit) break;
                        }
                        candidate = prev[candidate & (windowSize - 1)];
                    }
                }
            }
            if (bestLength >= 3) {
                tokens.push({ type: 'm', length: bestLength, distance: bestDistance });
                for (var step = 0; step < bestLength; step++) insert(index + step);
                index += bestLength;
            } else {
                tokens.push({ type: 'l', value: input[index] });
                insert(index);
                index++;
            }
        }
        return tokens;
    }

    /**
     * 把 token 列表写成固定 Huffman 块。
     * @param {Array} tokens
     * @returns {Uint8Array} 不含 zlib 头与校验的 deflate 数据
     */
    function writeFixedBlock(tokens) {
        var writer = new BitWriter();
        writer.writeBits(1, 1);   // 最后一块
        writer.writeBits(1, 2);   // 固定 Huffman
        for (var i = 0; i < tokens.length; i++) {
            var token = tokens[i];
            if (token.type === 'l') {
                writeFixedLiteral(writer, token.value);
                continue;
            }
            var lSymbolIndex = lengthSymbol(token.length);
            writeFixedLiteral(writer, 257 + lSymbolIndex);
            var lExtra = LENGTH_EXTRA[lSymbolIndex];
            if (lExtra) writer.writeBits(token.length - LENGTH_BASE[lSymbolIndex], lExtra);
            var dSymbolIndex = distSymbol(token.distance);
            writeFixedDistance(writer, dSymbolIndex);
            var dExtra = DIST_EXTRA[dSymbolIndex];
            // 长度与距离的额外位都是 LSB-first，直接传原值，不要镜像
            if (dExtra) writer.writeBits(token.distance - DIST_BASE[dSymbolIndex], dExtra);
        }
        writeFixedLiteral(writer, 256);
        writer.flush();
        return new Uint8Array(writer.bytes);
    }

    /**
     * 用固定 Huffman 表压缩字节流。
     * @param {Uint8Array} input
     * @param {number} [level] 0 = 只存不压（store 块），1-3 = LZ77 匹配强度
     */
    function deflateFixed(input, level) {
        var strategy = level === undefined ? 2 : util.clamp(level, 0, 3, 2);
        if (strategy === 0) {
            // store 模式：每个块最多 65535 字节，头部位写入后按字节追加原始数据
            var out = [];
            var offset = 0;
            var header = new BitWriter();
            while (offset < input.length) {
                var size = Math.min(65535, input.length - offset);
                var last = offset + size >= input.length ? 1 : 0;
                header.writeBits(last, 1);
                header.writeBits(0, 2);
                header.flush();
                out = out.concat(header.bytes);
                out.push(size & 0xFF, (size >>> 8) & 0xFF, (~size) & 0xFF, ((~size) >>> 8) & 0xFF);
                for (var k = 0; k < size; k++) out.push(input[offset + k]);
                header = new BitWriter();
                offset += size;
            }
            return new Uint8Array(out);
        }
        return writeFixedBlock(tokenize(input, strategy));
    }

    function adler32(bytes) {
        var a = 1;
        var b = 0;
        var MOD = 65521;
        for (var i = 0; i < bytes.length; i++) {
            a = (a + bytes[i]) % MOD;
            b = (b + a) % MOD;
        }
        return ((b << 16) | a) >>> 0;
    }

    /** 组装 zlib 容器 */
    function zlibCompress(bytes, level) {
        var body = deflateFixed(bytes, level);
        var out = new Uint8Array(body.length + 6);
        out[0] = 0x78;
        out[1] = 0x01;
        out.set(body, 2);
        var checksum = adler32(bytes);
        out[body.length + 2] = (checksum >>> 24) & 0xFF;
        out[body.length + 3] = (checksum >>> 16) & 0xFF;
        out[body.length + 4] = (checksum >>> 8) & 0xFF;
        out[body.length + 5] = checksum & 0xFF;
        return out;
    }

    /* ============================================================
     * PNG
     * ============================================================ */

    function chunk(type, data) {
        var out = new Uint8Array(12 + data.length);
        var length = data.length;
        out[0] = (length >>> 24) & 0xFF;
        out[1] = (length >>> 16) & 0xFF;
        out[2] = (length >>> 8) & 0xFF;
        out[3] = length & 0xFF;
        for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(data, 8);
        var crcInput = new Uint8Array(4 + data.length);
        crcInput.set(out.subarray(4, 8), 0);
        crcInput.set(data, 4);
        var value = crc32(crcInput);
        out[8 + data.length] = (value >>> 24) & 0xFF;
        out[9 + data.length] = (value >>> 16) & 0xFF;
        out[10 + data.length] = (value >>> 8) & 0xFF;
        out[11 + data.length] = value & 0xFF;
        return out;
    }

    /**
     * 逐行做 Paeth 预测，降低熵以提高压缩率。
     * @param {Uint8Array} raw 未过滤的扫描线（已含 filter 字节位）
     */
    function filterScanlines(raw, width, height, channels) {
        var stride = width * channels;
        var out = new Uint8Array((stride + 1) * height);
        var prior = new Uint8Array(stride);
        for (var y = 0; y < height; y++) {
            var rowStart = y * stride;
            var outStart = y * (stride + 1);
            out[outStart] = 4; // Paeth
            for (var x = 0; x < stride; x++) {
                var a = x >= channels ? raw[rowStart + x - channels] : 0;
                var b = prior[x];
                var c = x >= channels ? prior[x - channels] : 0;
                var p = a + b - c;
                var pa = Math.abs(p - a);
                var pb = Math.abs(p - b);
                var pc = Math.abs(p - c);
                var predictor = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                out[outStart + 1 + x] = (raw[rowStart + x] - predictor) & 0xFF;
            }
            prior.set(raw.subarray(rowStart, rowStart + stride));
        }
        return out;
    }

    /**
     * 编码 PNG。
     * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number, channels?:number}} image
     *        data 为交错通道（chunky），channels 3 或 4
     * @param {{level?:number, colorType?:number, srgb?:boolean}} [options]
     * @returns {Uint8Array}
     */
    function encodePng(image, options) {
        var opts = options || {};
        var width = Math.max(1, Math.round(util.toNumber(image && image.width, 1)));
        var height = Math.max(1, Math.round(util.toNumber(image && image.height, 1)));
        var source = image && image.data ? image.data : new Uint8Array(width * height * 4);
        var channels = util.clamp(image && image.channels ? image.channels : 4, 1, 4, 4);
        if (channels === 1 || channels === 2) channels = 3;
        var colorType = opts.colorType !== undefined ? opts.colorType : (channels === 4 ? 6 : 2);
        var expected = width * height * channels;
        var raw = new Uint8Array(expected);
        if (source.length >= expected) {
            raw.set(source.subarray(0, expected));
        } else {
            // 通道数不符时按 4 通道解释再抽取，避免越界
            for (var i = 0; i < width * height; i++) {
                var s = i * 4;
                var d = i * channels;
                raw[d] = source[s] || 0;
                raw[d + 1] = source[s + 1] || 0;
                raw[d + 2] = source[s + 2] || 0;
                if (channels === 4) raw[d + 3] = source[s + 3] === undefined ? 255 : source[s + 3];
            }
        }

        var filtered = filterScanlines(raw, width, height, channels);
        var compressed = zlibCompress(filtered, opts.level === undefined ? 2 : opts.level);

        var ihdr = new Uint8Array(13);
        ihdr[0] = (width >>> 24) & 0xFF; ihdr[1] = (width >>> 16) & 0xFF;
        ihdr[2] = (width >>> 8) & 0xFF; ihdr[3] = width & 0xFF;
        ihdr[4] = (height >>> 24) & 0xFF; ihdr[5] = (height >>> 16) & 0xFF;
        ihdr[6] = (height >>> 8) & 0xFF; ihdr[7] = height & 0xFF;
        ihdr[8] = 8;                 // 位深
        ihdr[9] = colorType;         // 2 = truecolor, 6 = truecolor+alpha
        ihdr[10] = 0;                // 压缩方法
        ihdr[11] = 0;                // 过滤方法
        ihdr[12] = 0;                // 非交错

        var parts = [
            new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', ihdr)
        ];
        if (opts.srgb !== false) {
            // sRGB 块：渲染意图 0（感知），与 Adobe 默认一致
            parts.push(chunk('sRGB', new Uint8Array([0])));
            // gAMA 45455 = 1/2.2，配合 sRGB 块给旧解码器兜底
            parts.push(chunk('gAMA', new Uint8Array([0x00, 0x00, 0xB1, 0x8F])));
        }
        parts.push(chunk('IDAT', compressed));
        parts.push(chunk('IEND', new Uint8Array(0)));

        var total = 0;
        for (var p = 0; p < parts.length; p++) total += parts[p].length;
        var png = new Uint8Array(total);
        var cursor = 0;
        for (var q = 0; q < parts.length; q++) {
            png.set(parts[q], cursor);
            cursor += parts[q].length;
        }
        return png;
    }

    /**
     * 给已有 PNG 字节流补 sRGB 块（有些来源图没有色彩标记）。
     * 已存在 sRGB / iCCP 时原样返回。
     */
    function ensureSrgbChunk(pngBytes) {
        var bytes = pngBytes instanceof Uint8Array ? pngBytes : new Uint8Array(pngBytes);
        if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return bytes;
        var cursor = 8;
        var insertAt = -1;
        while (cursor + 8 <= bytes.length) {
            var length = (bytes[cursor] << 24) | (bytes[cursor + 1] << 16) | (bytes[cursor + 2] << 8) | bytes[cursor + 3];
            var type = String.fromCharCode(bytes[cursor + 4], bytes[cursor + 5], bytes[cursor + 6], bytes[cursor + 7]);
            if (type === 'sRGB' || type === 'iCCP') return bytes;
            if (type === 'IHDR') insertAt = cursor + 12 + length;
            if (type === 'IDAT' || type === 'IEND') break;
            cursor += 12 + length;
        }
        if (insertAt < 0) return bytes;
        var block = chunk('sRGB', new Uint8Array([0]));
        var out = new Uint8Array(bytes.length + block.length);
        out.set(bytes.subarray(0, insertAt), 0);
        out.set(block, insertAt);
        out.set(bytes.subarray(insertAt), insertAt + block.length);
        return out;
    }

    /* ============================================================
     * Baseline JPEG
     * ============================================================ */

    var ZIGZAG = [
        0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
        12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
        35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
        58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
    ];

    var STD_LUMA_QUANT = [
        16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
        14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
        18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
        49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
    ];

    var STD_CHROMA_QUANT = [
        17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
        24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
        99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
    ];

    var STD_DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
    var STD_DC_LUMA_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    var STD_DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
    var STD_DC_CHROMA_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    var STD_AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D, 0];
    var STD_AC_LUMA_VALUES = [
        0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
        0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
        0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
        0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
        0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
        0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
        0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
        0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
        0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
        0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
        0xF9, 0xFA
    ];
    var STD_AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77, 0];
    var STD_AC_CHROMA_VALUES = [
        0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
        0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0,
        0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
        0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
        0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
        0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
        0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
        0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3,
        0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
        0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
        0xF9, 0xFA
    ];

    /** 由 BITS/VALUES 表构建霍夫曼编码查找表：{code, length} */
    function buildHuffmanTable(bits, values) {
        var table = {};
        var code = 0;
        var k = 0;
        for (var length = 1; length <= 16; length++) {
            for (var i = 0; i < bits[length]; i++) {
                table[values[k]] = { code: code, length: length };
                code++;
                k++;
            }
            code <<= 1;
        }
        return table;
    }

    var HUFFMAN = {
        dcLuma: buildHuffmanTable(STD_DC_LUMA_BITS, STD_DC_LUMA_VALUES),
        dcChroma: buildHuffmanTable(STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALUES),
        acLuma: buildHuffmanTable(STD_AC_LUMA_BITS, STD_AC_LUMA_VALUES),
        acChroma: buildHuffmanTable(STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALUES)
    };

    /** 亮度/色度共用的前向 DCT（分离式，8×8） */
    var DCT_COS = (function () {
        var table = [];
        for (var u = 0; u < 8; u++) {
            table[u] = [];
            for (var x = 0; x < 8; x++) {
                table[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
            }
        }
        return table;
    })();

    var DCT_SCALE = (function () {
        var scale = [];
        for (var u = 0; u < 8; u++) {
            scale[u] = u === 0 ? Math.SQRT1_2 : 1;
        }
        return scale;
    })();

    function forwardDct(block, output) {
        var temp = new Float32Array(64);
        for (var y = 0; y < 8; y++) {
            for (var u = 0; u < 8; u++) {
                var sum = 0;
                for (var x = 0; x < 8; x++) sum += block[y * 8 + x] * DCT_COS[u][x];
                temp[y * 8 + u] = sum * 0.5 * DCT_SCALE[u];
            }
        }
        for (var v = 0; v < 8; v++) {
            for (var xf = 0; xf < 8; xf++) {
                var accum = 0;
                for (var yf = 0; yf < 8; yf++) accum += temp[yf * 8 + xf] * DCT_COS[v][yf];
                output[v * 8 + xf] = accum * 0.5 * DCT_SCALE[v];
            }
        }
        return output;
    }

    /** 类别（bit length）与幅值编码 */
    function magnitudeCategory(value) {
        var abs = Math.abs(value);
        var category = 0;
        while (abs) { abs >>= 1; category++; }
        return category;
    }

    function JpegBitWriter() {
        this.bytes = [];
        this.buffer = 0;
        this.count = 0;
    }
    JpegBitWriter.prototype.write = function (code, length) {
        for (var i = length - 1; i >= 0; i--) {
            this.buffer = (this.buffer << 1) | ((code >>> i) & 1);
            this.count++;
            if (this.count === 8) {
                this.bytes.push(this.buffer & 0xFF);
                if ((this.buffer & 0xFF) === 0xFF) this.bytes.push(0x00); // 字节填充
                this.buffer = 0;
                this.count = 0;
            }
        }
    };
    JpegBitWriter.prototype.flush = function () {
        while (this.count !== 0) this.write(1, 1);
    };

    function writeValue(writer, value) {
        var category = magnitudeCategory(value);
        if (category === 0) return;
        var encoded = value > 0 ? value : value + (1 << category) - 1;
        writer.write(encoded, category);
    }

    function encodeBlock(writer, block, quant, dcTable, acTable, previousDc) {
        var coefficients = new Float32Array(64);
        forwardDct(block, coefficients);
        var quantized = new Int32Array(64);
        for (var i = 0; i < 64; i++) {
            quantized[i] = Math.round(coefficients[i] / quant[i]);
        }

        var diff = quantized[0] - previousDc;
        var dcCategory = magnitudeCategory(diff);
        var dcCode = dcTable[dcCategory];
        writer.write(dcCode.code, dcCode.length);
        writeValue(writer, diff);

        var run = 0;
        for (var zig = 1; zig < 64; zig++) {
            var value = quantized[ZIGZAG[zig]];
            if (value === 0) { run++; continue; }
            while (run > 15) {
                var zrl = acTable[0xF0];
                writer.write(zrl.code, zrl.length);
                run -= 16;
            }
            var category = magnitudeCategory(value);
            var symbol = (run << 4) | category;
            var code = acTable[symbol];
            if (code) writer.write(code.code, code.length);
            writeValue(writer, value);
            run = 0;
        }
        if (run > 0) {
            var eob = acTable[0x00];
            writer.write(eob.code, eob.length);
        }
        return quantized[0];
    }

    /**
     * 编码 Baseline JPEG。
     * @param {{data:Uint8Array|Uint8ClampedArray, width:number, height:number, channels?:number}} image
     * @param {{quality?:number}} [options] quality 1-100，默认 92
     * @returns {Uint8Array}
     */
    function encodeJpeg(image, options) {
        var opts = options || {};
        var width = Math.max(1, Math.round(util.toNumber(image && image.width, 1)));
        var height = Math.max(1, Math.round(util.toNumber(image && image.height, 1)));
        var source = image && image.data ? image.data : new Uint8Array(width * height * 4);
        var sourceChannels = util.clamp(image && image.channels ? image.channels : 4, 1, 4, 4);
        var quality = util.clamp(opts.quality === undefined ? 92 : opts.quality, 1, 100, 92);

        var scale = quality < 50 ? Math.floor(5000 / quality) : Math.floor(200 - quality * 2);
        var lumaQuant = new Float32Array(64);
        var chromaQuant = new Float32Array(64);
        for (var i = 0; i < 64; i++) {
            lumaQuant[i] = util.clamp(Math.floor((STD_LUMA_QUANT[i] * scale + 50) / 100), 1, 255, 1);
            chromaQuant[i] = util.clamp(Math.floor((STD_CHROMA_QUANT[i] * scale + 50) / 100), 1, 255, 1);
        }

        // 色度下采样 2×2（4:2:0），与常见导出器一致
        var lumaWidth = width;
        var lumaHeight = height;
        var chromaWidth = Math.ceil(width / 2);
        var chromaHeight = Math.ceil(height / 2);
        var yPlane = new Float32Array(lumaWidth * lumaHeight);
        var cbPlane = new Float32Array(chromaWidth * chromaHeight);
        var crPlane = new Float32Array(chromaWidth * chromaHeight);

        for (var y = 0; y < lumaHeight; y++) {
            for (var x = 0; x < lumaWidth; x++) {
                var offset = (y * width + x) * sourceChannels;
                var r = source[offset] || 0;
                var g = sourceChannels >= 3 ? (source[offset + 1] || 0) : r;
                var b = sourceChannels >= 3 ? (source[offset + 2] || 0) : r;
                yPlane[y * lumaWidth + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
            }
        }
        for (var cy = 0; cy < chromaHeight; cy++) {
            for (var cx = 0; cx < chromaWidth; cx++) {
                var sumCb = 0;
                var sumCr = 0;
                var samples = 0;
                for (var dy = 0; dy < 2; dy++) {
                    for (var dx = 0; dx < 2; dx++) {
                        var px = cx * 2 + dx;
                        var py = cy * 2 + dy;
                        if (px >= width || py >= height) continue;
                        var o = (py * width + px) * sourceChannels;
                        var rr = source[o] || 0;
                        var gg = sourceChannels >= 3 ? (source[o + 1] || 0) : rr;
                        var bb = sourceChannels >= 3 ? (source[o + 2] || 0) : rr;
                        sumCb += -0.168736 * rr - 0.331264 * gg + 0.5 * bb;
                        sumCr += 0.5 * rr - 0.418688 * gg - 0.081312 * bb;
                        samples++;
                    }
                }
                var n = samples || 1;
                cbPlane[cy * chromaWidth + cx] = sumCb / n;
                crPlane[cy * chromaWidth + cx] = sumCr / n;
            }
        }

        var writer = new JpegBitWriter();

        function encodePlane(plane, planeWidth, planeHeight, quant, dcTable, acTable) {
            var block = new Float32Array(64);
            var previousDc = 0;
            for (var by = 0; by < planeHeight; by += 8) {
                for (var bx = 0; bx < planeWidth; bx += 8) {
                    for (var yy = 0; yy < 8; yy++) {
                        for (var xx = 0; xx < 8; xx++) {
                            var sx = Math.min(planeWidth - 1, bx + xx);
                            var sy = Math.min(planeHeight - 1, by + yy);
                            block[yy * 8 + xx] = plane[sy * planeWidth + sx];
                        }
                    }
                    previousDc = encodeBlock(writer, block, quant, dcTable, acTable, previousDc);
                }
            }
        }

        // 三个分量交错编码：按 MCU（16×16）逐块写入
        var mcuCols = Math.ceil(width / 16);
        var mcuRows = Math.ceil(height / 16);
        var yBlock = new Float32Array(64);
        var cbBlock = new Float32Array(64);
        var crBlock = new Float32Array(64);
        var dcY = 0, dcCb = 0, dcCr = 0;

        for (var my = 0; my < mcuRows; my++) {
            for (var mx = 0; mx < mcuCols; mx++) {
                for (var subY = 0; subY < 2; subY++) {
                    for (var subX = 0; subX < 2; subX++) {
                        for (var by2 = 0; by2 < 8; by2++) {
                            for (var bx2 = 0; bx2 < 8; bx2++) {
                                var sx2 = Math.min(lumaWidth - 1, mx * 16 + subX * 8 + bx2);
                                var sy2 = Math.min(lumaHeight - 1, my * 16 + subY * 8 + by2);
                                yBlock[by2 * 8 + bx2] = yPlane[sy2 * lumaWidth + sx2];
                            }
                        }
                        dcY = encodeBlock(writer, yBlock, lumaQuant, HUFFMAN.dcLuma, HUFFMAN.acLuma, dcY);
                    }
                }
                for (var by3 = 0; by3 < 8; by3++) {
                    for (var bx3 = 0; bx3 < 8; bx3++) {
                        var sx3 = Math.min(chromaWidth - 1, mx * 8 + bx3);
                        var sy3 = Math.min(chromaHeight - 1, my * 8 + by3);
                        cbBlock[by3 * 8 + bx3] = cbPlane[sy3 * chromaWidth + sx3];
                        crBlock[by3 * 8 + bx3] = crPlane[sy3 * chromaWidth + sx3];
                    }
                }
                dcCb = encodeBlock(writer, cbBlock, chromaQuant, HUFFMAN.dcChroma, HUFFMAN.acChroma, dcCb);
                dcCr = encodeBlock(writer, crBlock, chromaQuant, HUFFMAN.dcChroma, HUFFMAN.acChroma, dcCr);
            }
        }
        writer.flush();
        void encodePlane;

        /* ---- 组装 JFIF 文件 ---- */
        var segments = [];
        function marker(code, payload) {
            segments.push(new Uint8Array([0xFF, code]));
            if (payload) {
                segments.push(new Uint8Array([(payload.length + 2) >> 8, (payload.length + 2) & 0xFF]));
                segments.push(payload);
            }
        }

        segments.push(new Uint8Array([0xFF, 0xD8])); // SOI
        var jfif = new Uint8Array(14);
        jfif.set([0x4A, 0x46, 0x49, 0x46, 0x00], 0); // 'JFIF\0'
        jfif[5] = 1; jfif[6] = 1;    // 版本 1.1
        jfif[7] = 1;                 // 密度单位：点/英寸
        jfif[8] = 0; jfif[9] = 72;
        jfif[10] = 0; jfif[11] = 72;
        jfif[12] = 0; jfif[13] = 0;
        marker(0xE0, jfif);

        // DQT
        var dqt = new Uint8Array(2 + 128);
        dqt[0] = 0x00;
        for (var qi = 0; qi < 64; qi++) dqt[1 + qi] = lumaQuant[ZIGZAG[qi]];
        dqt[65] = 0x01;
        for (var qj = 0; qj < 64; qj++) dqt[65 + qj] = chromaQuant[ZIGZAG[qj]];
        marker(0xDB, dqt);

        // SOF0
        var sof = new Uint8Array(15);
        sof[0] = 8;
        sof[1] = (height >> 8) & 0xFF; sof[2] = height & 0xFF;
        sof[3] = (width >> 8) & 0xFF; sof[4] = width & 0xFF;
        sof[5] = 3;
        sof[6] = 1; sof[7] = 0x22; sof[8] = 0;   // Y: 2×2 采样
        sof[9] = 2; sof[10] = 0x11; sof[11] = 1; // Cb
        sof[12] = 3; sof[13] = 0x11; sof[14] = 1;// Cr
        marker(0xC0, sof);

        // DHT
        marker(0xC4, buildDhtPayload());

        // SOS
        var sos = new Uint8Array(10);
        sos[0] = 3;
        sos[1] = 1; sos[2] = 0x00;
        sos[3] = 2; sos[4] = 0x11;
        sos[5] = 3; sos[6] = 0x11;
        sos[7] = 0; sos[8] = 63; sos[9] = 0;
        marker(0xDA, sos);

        var entropy = new Uint8Array(writer.bytes);
        segments.push(entropy);
        segments.push(new Uint8Array([0xFF, 0xD9])); // EOI

        var totalLength = 0;
        for (var s = 0; s < segments.length; s++) totalLength += segments[s].length;
        var out = new Uint8Array(totalLength);
        var cursor = 0;
        for (var t = 0; t < segments.length; t++) {
            out.set(segments[t], cursor);
            cursor += segments[t].length;
        }
        return out;
    }

    function buildDhtPayload() {
        var payload = [];
        function pushTable(classId, tableId, bits, values) {
            payload.push((classId << 4) | tableId);
            for (var i = 1; i <= 16; i++) payload.push(bits[i]);
            for (var v = 0; v < values.length; v++) payload.push(values[v]);
        }
        pushTable(0, 0, STD_DC_LUMA_BITS, STD_DC_LUMA_VALUES);
        pushTable(1, 0, STD_AC_LUMA_BITS, STD_AC_LUMA_VALUES);
        pushTable(0, 1, STD_DC_CHROMA_BITS, STD_DC_CHROMA_VALUES);
        pushTable(1, 1, STD_AC_CHROMA_BITS, STD_AC_CHROMA_VALUES);
        return new Uint8Array(payload);
    }

    /* ============================================================
     * 像素工具
     * ============================================================ */

    /**
     * 双线性缩放 RGBA/RGB 缓冲，返回新的 Uint8ClampedArray。
     * @param {{data:*, width:number, height:number, channels:number}} image
     */
    function resizeImage(image, targetWidth, targetHeight) {
        var channels = util.clamp(image.channels || 4, 1, 4, 4);
        var sourceWidth = Math.max(1, Math.round(util.toNumber(image.width, 1)));
        var sourceHeight = Math.max(1, Math.round(util.toNumber(image.height, 1)));
        var width = Math.max(1, Math.round(util.toNumber(targetWidth, sourceWidth)));
        var height = Math.max(1, Math.round(util.toNumber(targetHeight, sourceHeight)));
        var source = image.data;
        var out = new Uint8ClampedArray(width * height * channels);

        if (width === sourceWidth && height === sourceHeight) {
            out.set(source.subarray ? source.subarray(0, out.length) : source);
            return { data: out, width: width, height: height, channels: channels };
        }

        // 缩小时先做一次盒式平均，避免直接双线性产生锯齿与噪点
        var shrunk = source;
        var shrunkWidth = sourceWidth;
        var shrunkHeight = sourceHeight;
        if (width < sourceWidth || height < sourceHeight) {
            var factor = Math.max(sourceWidth / width, sourceHeight / height);
            if (factor >= 2) {
                var step = Math.max(1, Math.floor(factor));
                shrunkWidth = Math.max(1, Math.floor(sourceWidth / step));
                shrunkHeight = Math.max(1, Math.floor(sourceHeight / step));
                var boxed = new Uint8ClampedArray(shrunkWidth * shrunkHeight * channels);
                for (var by = 0; by < shrunkHeight; by++) {
                    for (var bx = 0; bx < shrunkWidth; bx++) {
                        var acc = new Float32Array(channels);
                        var count = 0;
                        for (var oy = 0; oy < step; oy++) {
                            for (var ox = 0; ox < step; ox++) {
                                var sxp = Math.min(sourceWidth - 1, bx * step + ox);
                                var syp = Math.min(sourceHeight - 1, by * step + oy);
                                var sOff = (syp * sourceWidth + sxp) * channels;
                                for (var ch = 0; ch < channels; ch++) acc[ch] += source[sOff + ch];
                                count++;
                            }
                        }
                        var dOff = (by * shrunkWidth + bx) * channels;
                        for (var ch2 = 0; ch2 < channels; ch2++) boxed[dOff + ch2] = acc[ch2] / (count || 1);
                    }
                }
                shrunk = boxed;
            }
        }

        var xRatio = shrunkWidth / width;
        var yRatio = shrunkHeight / height;
        for (var y = 0; y < height; y++) {
            var sourceY = (y + 0.5) * yRatio - 0.5;
            if (sourceY < 0) sourceY = 0;
            var y0 = Math.floor(sourceY);
            var y1 = Math.min(shrunkHeight - 1, y0 + 1);
            var fy = sourceY - y0;
            for (var x = 0; x < width; x++) {
                var sourceX = (x + 0.5) * xRatio - 0.5;
                if (sourceX < 0) sourceX = 0;
                var x0 = Math.floor(sourceX);
                var x1 = Math.min(shrunkWidth - 1, x0 + 1);
                var fx = sourceX - x0;
                var target = (y * width + x) * channels;
                for (var c = 0; c < channels; c++) {
                    var p00 = shrunk[(y0 * shrunkWidth + x0) * channels + c];
                    var p10 = shrunk[(y0 * shrunkWidth + x1) * channels + c];
                    var p01 = shrunk[(y1 * shrunkWidth + x0) * channels + c];
                    var p11 = shrunk[(y1 * shrunkWidth + x1) * channels + c];
                    var top = p00 + (p10 - p00) * fx;
                    var bottom = p01 + (p11 - p01) * fx;
                    out[target + c] = top + (bottom - top) * fy;
                }
            }
        }
        return { data: out, width: width, height: height, channels: channels };
    }

    /** RGB → 灰度（Rec.709 luma），返回 Float32Array（0-255） */
    function toLuma(data, width, height, channels) {
        var out = new Float32Array(width * height);
        for (var i = 0; i < width * height; i++) {
            var offset = i * channels;
            out[i] = 0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2];
        }
        return out;
    }

    /* ============================================================
     * DEFLATE 解压（固定 / 动态 Huffman 都支持）
     *
     * 为什么不用宿主自带的 DecompressionStream：UXP 上没有这个 API，
     * 而浏览器的实现遇到损坏数据会抛出无法捕获的流错误。自己解更可控。
     * ============================================================ */
    function inflate(bytes, maxOutput) {
        var limit = util.toNumber(maxOutput, 0) || 64 * 1024 * 1024;
        var bits = [];
        for (var i = 0; i < bytes.length; i++) {
            for (var k = 0; k < 8; k++) bits.push((bytes[i] >> k) & 1);
        }
        var cursor = 0;
        var out = [];

        /*
         * 读比特。越界必须抛错而不是返回 0：
         * 返回 0 会让解码器一直读到"块结束"码，形成死循环（曾把测试卡死 60 秒）。
         */
        function readBits(count) {
            var value = 0;
            for (var j = 0; j < count; j++) {
                if (cursor >= bits.length) throw new Error('inflate: unexpected end of data');
                value |= bits[cursor++] << j;
            }
            return value;
        }

        function buildTable(lengths) {
            var table = {};
            var maxBits = 0;
            var l;
            for (l = 0; l < lengths.length; l++) {
                if (lengths[l] > maxBits) maxBits = lengths[l];
            }
            var blCount = new Array(maxBits + 1);
            for (l = 0; l <= maxBits; l++) blCount[l] = 0;
            for (l = 0; l < lengths.length; l++) {
                if (lengths[l]) blCount[lengths[l]]++;
            }
            var nextCode = new Array(maxBits + 1);
            var code = 0;
            for (var b = 1; b <= maxBits; b++) {
                code = (code + (blCount[b - 1] || 0)) << 1;
                nextCode[b] = code;
            }
            for (var symbol = 0; symbol < lengths.length; symbol++) {
                var len = lengths[symbol];
                if (!len) continue;
                /*
                 * 关键：表里存的必须是**镜像后的码**，因为 encodePng/encodeJpeg 一侧
                 * 写进比特流的是 reverseBits(规范码, len)（见 writeFixedLiteral）。
                 * 解码器按 LSB-first 逐位累积，累积到 len 位时正好等于那个镜像值。
                 * 若这里存规范码，查表方向就是反的 —— 表现是首字节就 "bad code"。
                 */
                table[len + ':' + reverseBits(nextCode[len], len)] = symbol;
                nextCode[len]++;
            }
            return table;
        }

        function readSymbol(table) {
            var acc = 0;
            for (var len = 1; len <= 15; len++) {
                if (cursor >= bits.length) throw new Error('inflate: unexpected end of data');
                acc |= bits[cursor++] << (len - 1);
                var hit = table[len + ':' + acc];
                if (hit !== undefined) return hit;
            }
            throw new Error('inflate: bad code');
        }

        var FIXED_LIT = (function () {
            var lengths = [];
            for (var s = 0; s < 288; s++) {
                if (s <= 143) lengths.push(8);
                else if (s <= 255) lengths.push(9);
                else if (s <= 279) lengths.push(7);
                else lengths.push(8);
            }
            return buildTable(lengths);
        })();
        var FIXED_DIST = (function () {
            var lengths = [];
            for (var d = 0; d < 32; d++) lengths.push(5);
            return buildTable(lengths);
        })();

        var finalBlock = false;
        while (!finalBlock) {
            finalBlock = readBits(1) === 1;
            var type = readBits(2);
            var litTable;
            var distTable;
            if (type === 0) {
                cursor = (cursor + 7) & ~7;
                var len = readBits(16);
                readBits(16);
                for (var p = 0; p < len; p++) out.push(readBits(8));
                continue;
            }
            if (type === 1) {
                litTable = FIXED_LIT;
                distTable = FIXED_DIST;
            } else if (type === 2) {
                var hlit = readBits(5) + 257;
                var hdist = readBits(5) + 1;
                var hclen = readBits(4) + 4;
                var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
                var clLengths = [];
                for (var ci = 0; ci < 19; ci++) clLengths.push(0);
                for (var oi = 0; oi < hclen; oi++) clLengths[order[oi]] = readBits(3);
                var clTable = buildTable(clLengths);
                var lengths = [];
                while (lengths.length < hlit + hdist) {
                    var sym = readSymbol(clTable);
                    if (sym < 16) lengths.push(sym);
                    else if (sym === 16) {
                        var repeat = 3 + readBits(2);
                        var prev = lengths[lengths.length - 1] || 0;
                        while (repeat--) lengths.push(prev);
                    } else if (sym === 17) {
                        var r17 = 3 + readBits(3);
                        while (r17--) lengths.push(0);
                    } else {
                        var r18 = 11 + readBits(7);
                        while (r18--) lengths.push(0);
                    }
                }
                litTable = buildTable(lengths.slice(0, hlit));
                distTable = buildTable(lengths.slice(hlit));
            } else {
                throw new Error('inflate: invalid block type');
            }

            /*
             * 死循环闸门。
             *
             * 不能用"输出字节数超过 limit 就报错"：200 个相同字节只需要 2 个符号
             * （2 个字面量 + 一次长度 198 的重复匹配），输出与符号数完全不成比例，
             * 那样会把正常数据误判成异常。
             *
             * 正确的上界是**已消费的比特数**：每个符号至少消耗 1 个比特，
             * 所以迭代次数不可能超过剩余比特数。这样既不会误伤，也保证终止。
             */
            for (;;) {
                /*
                 * 终止保障放在两个与"压缩比"无关的地方，避免误伤正常数据：
                 *   1. readBits/readSymbol 在比特耗尽时抛错（数据读完了自然不会无限跑）；
                 *   2. 输出长度越过上限就报错 —— 上限由调用方按图像尺寸给出，
                 *      正常数据不可能超过它。
                 * 早先按"迭代次数"设闸门是错的：一次长度 258 的匹配只消耗两个符号，
                 * 却能产出 258 字节，符号数与输出量根本不成比例。
                 */
                if (out.length > limit) {
                    throw new Error('inflate: output exceeds limit ' + limit);
                }
                var code = readSymbol(litTable);
                if (code < 256) { out.push(code); continue; }
                if (code === 256) break;
                var li = code - 257;
                var length = LENGTH_BASE[li] + (LENGTH_EXTRA[li] ? readBits(LENGTH_EXTRA[li]) : 0);
                var dsym = readSymbol(distTable);
                var distance = DIST_BASE[dsym] + (DIST_EXTRA[dsym] ? readBits(DIST_EXTRA[dsym]) : 0);
                // 距离越界说明流已损坏：直接报出来，避免读到 undefined 后静默产出脏数据
                if (distance > out.length) {
                    throw new Error('inflate: distance ' + distance + ' beyond output ' + out.length +
                        ' (symbol ' + code + ', length ' + length + ')');
                }
                for (var copy = 0; copy < length; copy++) {
                    out.push(out[out.length - distance]);
                }
            }
        }
        return new Uint8Array(out);
    }

    /* ============================================================
     * UXP 兼容 PNG（照参考插件 zhuangai 的选区预览编码方式）
     *
     * 参考插件在 UXP 里能正常显示预览，它的 PNG 编码器特点是：
     *   1. 只输出 RGB（colorType 2），**不写 alpha**；
     *   2. 每行 filter=0（None），不做 Paeth 预测；
     *   3. deflate 用 **store 块（不压缩）**。
     *
     * 而我们默认的 encodePng 输出 RGBA（colorType 6）+ Paeth + 压缩。
     * 实测 UXP 对 RGBA PNG 解码有问题（元素 loaded 但不渲染），而 RGB 格式能显示。
     * 所以预览/选区回写这类"要给宿主看"的场景，统一走这个 UXP 兼容编码。
     * ============================================================ */
    function encodeUxpPng(image) {
        var width = Math.max(1, Math.round(util.toNumber(image && image.width, 1)));
        var height = Math.max(1, Math.round(util.toNumber(image && image.height, 1)));
        var source = image && image.data ? image.data : new Uint8Array(width * height * 4);
        var sourceChannels = util.clamp(image && image.channels ? image.channels : 4, 1, 4, 4);

        // 扫描线：filter(0) + RGB 每行
        var rowBytes = 1 + width * 3;
        var rawSize = rowBytes * height;
        var raw = new Uint8Array(rawSize);
        for (var y = 0; y < height; y++) {
            raw[y * rowBytes] = 0; // filter None
            for (var x = 0; x < width; x++) {
                var si = (y * width + x) * sourceChannels;
                var di = y * rowBytes + 1 + x * 3;
                raw[di] = source[si];
                raw[di + 1] = sourceChannels >= 3 ? source[si + 1] : source[si];
                raw[di + 2] = sourceChannels >= 3 ? source[si + 2] : source[si];
            }
        }

        // zlib 容器：store 块（不压缩）
        var MAX = 65535;
        var blockCount = Math.ceil(rawSize / MAX);
        var deflateSize = 2 + blockCount * 5 + rawSize + 4;
        var deflate = new Uint8Array(deflateSize);
        deflate[0] = 0x78;
        deflate[1] = 0x01;
        var offset = 2;
        for (var block = 0; block < blockCount; block++) {
            var start = block * MAX;
            var length = Math.min(MAX, rawSize - start);
            deflate[offset++] = (block === blockCount - 1) ? 1 : 0;
            deflate[offset++] = length & 0xFF;
            deflate[offset++] = (length >> 8) & 0xFF;
            deflate[offset++] = (~length) & 0xFF;
            deflate[offset++] = ((~length) >> 8) & 0xFF;
            deflate.set(raw.subarray(start, start + length), offset);
            offset += length;
        }
        var a1 = 1, a2 = 0;
        for (var ai = 0; ai < rawSize; ai++) {
            a1 = (a1 + raw[ai]) % 65521;
            a2 = (a2 + a1) % 65521;
        }
        var adler = ((a2 << 16) | a1) >>> 0;
        deflate[offset++] = (adler >>> 24) & 0xFF;
        deflate[offset++] = (adler >>> 16) & 0xFF;
        deflate[offset++] = (adler >>> 8) & 0xFF;
        deflate[offset++] = adler & 0xFF;

        function u32be(arr, pos, value) {
            arr[pos] = (value >>> 24) & 0xFF;
            arr[pos + 1] = (value >>> 16) & 0xFF;
            arr[pos + 2] = (value >>> 8) & 0xFF;
            arr[pos + 3] = value & 0xFF;
        }
        function chunk(type, data) {
            var out = new Uint8Array(12 + data.length);
            u32be(out, 0, data.length);
            out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
            out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
            out.set(data, 8);
            var crcInput = new Uint8Array(4 + data.length);
            crcInput.set(out.subarray(4, 8), 0);
            crcInput.set(data, 4);
            var crc = crc32(crcInput);
            u32be(out, 8 + data.length, crc);
            return out;
        }

        var ihdr = new Uint8Array(13);
        u32be(ihdr, 0, width);
        u32be(ihdr, 4, height);
        ihdr[8] = 8;   // bit depth
        ihdr[9] = 2;   // color type：truecolor（RGB，无 alpha）
        ihdr[10] = 0;  // 压缩方法
        ihdr[11] = 0;  // 过滤方法
        ihdr[12] = 0;  // 非交错

        var parts = [
            new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
            chunk('IHDR', ihdr),
            chunk('IDAT', deflate),
            chunk('IEND', new Uint8Array(0))
        ];
        var total = 0;
        for (var i = 0; i < parts.length; i++) total += parts[i].length;
        var png = new Uint8Array(total);
        var cursor = 0;
        for (var j = 0; j < parts.length; j++) {
            png.set(parts[j], cursor);
            cursor += parts[j].length;
        }
        return png;
    }

    /* ============================================================
     * PNG 解码（8 位 RGB/RGBA，支持全部 5 种行滤镜）
     *
     * 用途：预览与本地算法需要拿到像素。UXP 里 <img> 解码 data URL 并不可靠，
     * 自己解 PNG 再交给 canvas 绘制，链路完全可控。
     * ============================================================ */
    function decodePng(bytes) {
        var data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (data.length < 8 || data[0] !== 0x89 || data[1] !== 0x50) {
            throw new Error('decodePng: not a PNG');
        }
        var cursor = 8;
        var width = 0;
        var height = 0;
        var bitDepth = 8;
        var colorType = 6;
        var idat = [];
        while (cursor + 8 <= data.length) {
            var length = (data[cursor] << 24) | (data[cursor + 1] << 16) | (data[cursor + 2] << 8) | data[cursor + 3];
            var type = String.fromCharCode(data[cursor + 4], data[cursor + 5], data[cursor + 6], data[cursor + 7]);
            var body = data.subarray(cursor + 8, cursor + 8 + length);
            if (type === 'IHDR') {
                width = (body[0] << 24) | (body[1] << 16) | (body[2] << 8) | body[3];
                height = (body[4] << 24) | (body[5] << 16) | (body[6] << 8) | body[7];
                bitDepth = body[8];
                colorType = body[9];
            } else if (type === 'IDAT') {
                idat.push(body);
            } else if (type === 'IEND') {
                break;
            }
            cursor += 12 + length;
        }
        if (!width || !height) throw new Error('decodePng: missing IHDR');
        if (bitDepth !== 8) throw new Error('decodePng: only 8-bit PNG supported (got ' + bitDepth + ')');

        var merged = new Uint8Array(idat.reduce(function (sum, part) { return sum + part.length; }, 0));
        var offset = 0;
        for (var i = 0; i < idat.length; i++) {
            merged.set(idat[i], offset);
            offset += idat[i].length;
        }
        var expected = (width * channels + 1) * height;
        /*
         * IDAT 里是 **zlib 容器**（2 字节头 + deflate 数据 + 4 字节 adler32），
         * 而 inflate() 只吃裸 deflate。直接把整个流喂进去会导致首字节解析错位，
         * 表现为解到一半报 "unexpected end of data"。
         * 这里按 zlib 规范剥掉头尾；CMF 低 4 位是压缩方法（8 = deflate），
         * FLG 的第 5 位（0x20）表示带预设字典，遇到就直接报错。
         */
        var zlib = merged;
        if (merged.length >= 2 && (merged[0] & 0x0F) === 8) {
            var cmf = merged[0];
            var flg = merged[1];
            if ((cmf * 256 + flg) % 31 !== 0) {
                throw new Error('decodePng: bad zlib header');
            }
            if (flg & 0x20) {
                throw new Error('decodePng: preset dictionary not supported');
            }
            zlib = merged.subarray(2, merged.length - 4);
        }
        var raw = inflate(zlib, expected + 1024);
        if (raw.length < expected) {
            throw new Error('decodePng: truncated image data (' + raw.length + ' < ' + expected + ')');
        }

        var channels = colorType === 6 ? 4 : (colorType === 2 ? 3 : (colorType === 0 ? 1 : 0));
        if (!channels) throw new Error('decodePng: unsupported color type ' + colorType);
        var stride = width * channels;
        var rgba = new Uint8ClampedArray(width * height * 4);
        var prior = new Uint8Array(stride);
        var line = new Uint8Array(stride);

        for (var y = 0; y < height; y++) {
            var rowStart = y * (stride + 1);
            var filter = raw[rowStart];
            for (var x = 0; x < stride; x++) {
                var rawByte = raw[rowStart + 1 + x];
                var a = x >= channels ? line[x - channels] : 0;
                var b = prior[x];
                var c = x >= channels ? prior[x - channels] : 0;
                var pred = 0;
                if (filter === 1) pred = a;
                else if (filter === 2) pred = b;
                else if (filter === 3) pred = Math.floor((a + b) / 2);
                else if (filter === 4) {
                    var pp = a + b - c;
                    var pa = Math.abs(pp - a);
                    var pb = Math.abs(pp - b);
                    var pc = Math.abs(pp - c);
                    pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
                }
                line[x] = (rawByte + pred) & 0xFF;
            }
            for (var px = 0; px < width; px++) {
                var src = px * channels;
                var dst = (y * width + px) * 4;
                if (channels === 4) {
                    rgba[dst] = line[src];
                    rgba[dst + 1] = line[src + 1];
                    rgba[dst + 2] = line[src + 2];
                    rgba[dst + 3] = line[src + 3];
                } else if (channels === 3) {
                    rgba[dst] = line[src];
                    rgba[dst + 1] = line[src + 1];
                    rgba[dst + 2] = line[src + 2];
                    rgba[dst + 3] = 255;
                } else {
                    rgba[dst] = line[src];
                    rgba[dst + 1] = line[src];
                    rgba[dst + 2] = line[src];
                    rgba[dst + 3] = 255;
                }
            }
            prior.set(line);
        }
        return { data: rgba, width: width, height: height, channels: 4 };
    }

    /**
     * base64 → 字节。
     *
     * 不依赖 atob：UXP 上 atob 并非一定存在（宿主只保证 Adobe 自己的 API）。
     * 自研版本纯查表实现，任何环境都能跑。
     */
    var B64_TABLE = (function () {
        var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        var table = {};
        for (var i = 0; i < alphabet.length; i++) table[alphabet.charAt(i)] = i;
        return table;
    })();

    function base64ToBytes(text) {
        var source = String(text || '').replace(/[^A-Za-z0-9+/=]/g, '');
        var usable = source.indexOf('=') === -1 ? source.length : source.indexOf('=');
        var out = new Uint8Array(Math.floor((usable * 3) / 4));
        var position = 0;
        var buffer = 0;
        var bits = 0;
        for (var i = 0; i < usable; i++) {
            var value = B64_TABLE[source.charAt(i)];
            if (value === undefined) continue;
            buffer = (buffer << 6) | value;
            bits += 6;
            if (bits >= 8) {
                bits -= 8;
                out[position++] = (buffer >> bits) & 0xFF;
            }
        }
        return position === out.length ? out : out.subarray(0, position);
    }

    /** 从 data URL 解出 RGBA 像素 */
    function decodeDataUrlToImage(dataUrl) {
        var match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
        if (!match) throw new Error('decodeDataUrlToImage: not a data url');
        var mime = match[1] || '';
        var payload = match[3] || '';
        var bytes;
        if (match[2]) {
            bytes = base64ToBytes(payload);
        } else {
            var text = decodeURIComponent(payload);
            bytes = new Uint8Array(text.length);
            for (var j = 0; j < text.length; j++) bytes[j] = text.charCodeAt(j) & 0xFF;
        }
        if (mime.indexOf('png') !== -1 || (bytes[0] === 0x89 && bytes[1] === 0x50)) {
            return decodePng(bytes);
        }
        throw new Error('decodeDataUrlToImage: unsupported mime ' + mime);
    }

    DreamAI.PhotoEncode = {
        crc32: crc32,
        adler32: adler32,
        deflate: deflateFixed,
        tokenize: tokenize,
        __debug: { lengthSymbol: lengthSymbol, distSymbol: distSymbol, LENGTH_BASE: LENGTH_BASE, LENGTH_EXTRA: LENGTH_EXTRA },
        writeFixedBlock: writeFixedBlock,
        zlibCompress: zlibCompress,
        encodePng: encodePng,
        encodeUxpPng: encodeUxpPng,
        ensureSrgbChunk: ensureSrgbChunk,
        encodeJpeg: encodeJpeg,
        resizeImage: resizeImage,
        inflate: inflate,
        decodePng: decodePng,
        decodeDataUrlToImage: decodeDataUrlToImage,
        base64ToBytes: base64ToBytes,
        toLuma: toLuma,
        buildHuffmanTable: buildHuffmanTable
    };
})(typeof window !== 'undefined' ? window : this);
