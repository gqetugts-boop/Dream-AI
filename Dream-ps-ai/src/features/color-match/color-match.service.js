// ============================================================
// color-match.service.js — AI 回图颜色校准
//
// 职责：将回传图像匹配到原图低频色彩，并统一输出带 sRGB 标记的 PNG。
// 输入：源图与目标图的 data URL、校色方法和采样配置。
// 输出：校色后的 PNG data URL。
// 边界：不访问 Provider、不操作 Photoshop 文档、不管理界面状态。
// ============================================================

(function(global) {
    'use strict';

    var srgbToLinear = null;
    var crcTable = null;

    function loadImage(dataUrl, timeoutMs) {
        return new Promise(function(resolve, reject) {
            var image = new Image();
            var settled = false;
            var timer = setTimeout(function() {
                if (settled) return;
                settled = true;
                image.onload = null;
                image.onerror = null;
                reject(new Error('图片解码超时'));
            }, Math.max(1000, Number(timeoutMs) || 15000));
            image.onload = function() {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(image);
            };
            image.onerror = function() {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(new Error('图片解码失败'));
            };
            image.src = dataUrl;
        });
    }

    function inspectDataUrl(dataUrl) {
        return loadImage(dataUrl, 12000).then(function(image) {
            var width = image.naturalWidth || image.width || 0;
            var height = image.naturalHeight || image.height || 0;
            return { width: width, height: height, pixels: width * height };
        });
    }

    function initSrgbLut() {
        if (srgbToLinear) return;
        srgbToLinear = new Float32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i / 255;
            srgbToLinear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        }
    }

    function labCurve(value) {
        return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
    }

    function inverseLabCurve(value) {
        var cubed = value * value * value;
        return cubed > 0.008856 ? cubed : (value - 16 / 116) / 7.787;
    }

    function linearToSrgb(value) {
        if (value <= 0) return 0;
        var result = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
        return Math.max(0, Math.min(255, Math.round(result * 255)));
    }

    function rgbaToLab(data, count) {
        initSrgbLut();
        var lightness = new Float32Array(count);
        var channelA = new Float32Array(count);
        var channelB = new Float32Array(count);
        for (var i = 0, p = 0; i < count; i++, p += 4) {
            var r = srgbToLinear[data[p]];
            var g = srgbToLinear[data[p + 1]];
            var b = srgbToLinear[data[p + 2]];
            var x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
            var y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            var z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
            var fx = labCurve(x);
            var fy = labCurve(y);
            var fz = labCurve(z);
            lightness[i] = 116 * fy - 16;
            channelA[i] = 500 * (fx - fy);
            channelB[i] = 200 * (fy - fz);
        }
        return { L: lightness, a: channelA, b: channelB };
    }

    function meanAndStd(values, count, weights) {
        var sum = 0;
        var totalWeight = 0;
        var i;
        for (i = 0; i < count; i++) {
            var weight = weights ? weights[i] : 1;
            sum += values[i] * weight;
            totalWeight += weight;
        }
        if (totalWeight < 1e-6) totalWeight = count;
        var mean = sum / totalWeight;
        var squared = 0;
        for (i = 0; i < count; i++) {
            var delta = values[i] - mean;
            squared += delta * delta * (weights ? weights[i] : 1);
        }
        return { mean: mean, std: Math.max(1e-6, Math.sqrt(squared / totalWeight)) };
    }

    function writeLabToRgba(lightness, channelA, channelB, data, count) {
        for (var i = 0, p = 0; i < count; i++, p += 4) {
            var fy = (lightness[i] + 16) / 116;
            var fx = fy + channelA[i] / 500;
            var fz = fy - channelB[i] / 200;
            var x = inverseLabCurve(fx) * 0.95047;
            var y = inverseLabCurve(fy);
            var z = inverseLabCurve(fz) * 1.08883;
            data[p] = linearToSrgb(3.2406 * x - 1.5372 * y - 0.4986 * z);
            data[p + 1] = linearToSrgb(-0.9689 * x + 1.8758 * y + 0.0415 * z);
            data[p + 2] = linearToSrgb(0.0557 * x - 0.204 * y + 1.057 * z);
        }
    }

    function applyReinhard(output, input, count, weights) {
        var outLab = rgbaToLab(output, count);
        var inLab = rgbaToLab(input, count);
        ['L', 'a', 'b'].forEach(function(key) {
            var outputStats = meanAndStd(outLab[key], count, weights);
            var inputStats = meanAndStd(inLab[key], count, weights);
            var scale = inputStats.std / outputStats.std;
            for (var i = 0; i < count; i++) {
                outLab[key][i] = (outLab[key][i] - outputStats.mean) * scale + inputStats.mean;
            }
        });
        writeLabToRgba(outLab.L, outLab.a, outLab.b, output, count);
    }

    function blurHorizontal(source, target, width, height, radius) {
        for (var y = 0; y < height; y++) {
            var offset = y * width;
            var sum = 0;
            var count = 0;
            var x;
            var lead = Math.min(radius + 1, width);
            for (x = 0; x < lead; x++) { sum += source[offset + x]; count++; }
            target[offset] = sum / count;
            for (x = 1; x < width; x++) {
                var add = x + radius;
                var remove = x - radius - 1;
                if (add < width) { sum += source[offset + add]; count++; }
                if (remove >= 0) { sum -= source[offset + remove]; count--; }
                target[offset + x] = sum / count;
            }
        }
    }

    function blurVertical(source, target, width, height, radius) {
        for (var x = 0; x < width; x++) {
            var sum = 0;
            var count = 0;
            var y;
            var lead = Math.min(radius + 1, height);
            for (y = 0; y < lead; y++) { sum += source[y * width + x]; count++; }
            target[x] = sum / count;
            for (y = 1; y < height; y++) {
                var add = y + radius;
                var remove = y - radius - 1;
                if (add < height) { sum += source[add * width + x]; count++; }
                if (remove >= 0) { sum -= source[remove * width + x]; count--; }
                target[y * width + x] = sum / count;
            }
        }
    }

    function boxBlurThreePasses(buffer, temporary, width, height, radius) {
        for (var i = 0; i < 3; i++) {
            blurHorizontal(buffer, temporary, width, height, radius);
            blurVertical(temporary, buffer, width, height, radius);
        }
    }

    function applyWavelet(output, input, width, height) {
        var count = width * height;
        var radius = Math.max(4, Math.round(Math.min(width, height) / 16));
        var outputOriginal = new Float32Array(count);
        var outputLow = new Float32Array(count);
        var inputLow = new Float32Array(count);
        var temporary = new Float32Array(count);
        for (var channel = 0; channel < 3; channel++) {
            for (var i = 0, p = channel; i < count; i++, p += 4) {
                outputOriginal[i] = output[p];
                outputLow[i] = output[p];
                inputLow[i] = input[p];
            }
            boxBlurThreePasses(outputLow, temporary, width, height, radius);
            boxBlurThreePasses(inputLow, temporary, width, height, radius);
            for (var j = 0, q = channel; j < count; j++, q += 4) {
                output[q] = Math.max(0, Math.min(255, Math.round(outputOriginal[j] - outputLow[j] + inputLow[j])));
            }
        }
    }

    function pixelLuma(data, offset) {
        return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
    }

    function buildEdgeProxy(imageData, maxEdge) {
        var width = imageData.width;
        var height = imageData.height;
        var scale = Math.min(1, (maxEdge || 128) / Math.max(width, height));
        var proxyWidth = Math.max(8, Math.round(width * scale));
        var proxyHeight = Math.max(8, Math.round(height * scale));
        var gray = new Float32Array(proxyWidth * proxyHeight);
        var edge = new Float32Array(proxyWidth * proxyHeight);
        var data = imageData.data;
        for (var y = 0; y < proxyHeight; y++) {
            var sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / proxyHeight));
            for (var x = 0; x < proxyWidth; x++) {
                var sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / proxyWidth));
                gray[y * proxyWidth + x] = pixelLuma(data, (sourceY * width + sourceX) * 4);
            }
        }
        for (var py = 1; py < proxyHeight - 1; py++) {
            for (var px = 1; px < proxyWidth - 1; px++) {
                var tl = gray[(py - 1) * proxyWidth + px - 1];
                var tc = gray[(py - 1) * proxyWidth + px];
                var tr = gray[(py - 1) * proxyWidth + px + 1];
                var ml = gray[py * proxyWidth + px - 1];
                var mr = gray[py * proxyWidth + px + 1];
                var bl = gray[(py + 1) * proxyWidth + px - 1];
                var bc = gray[(py + 1) * proxyWidth + px];
                var br = gray[(py + 1) * proxyWidth + px + 1];
                var gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
                var gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
                edge[py * proxyWidth + px] = Math.min(255, Math.sqrt(gx * gx + gy * gy) * 0.25);
            }
        }
        return { gray: gray, edge: edge, width: proxyWidth, height: proxyHeight, scaleX: proxyWidth / width, scaleY: proxyHeight / height };
    }

    function estimateTranslation(outputImageData, referenceImageData, maxOffset) {
        var source = buildEdgeProxy(outputImageData, 128);
        var reference = buildEdgeProxy(referenceImageData, 128);
        var width = Math.min(source.width, reference.width);
        var height = Math.min(source.height, reference.height);
        var rangeX = Math.max(0, Math.min(18, Math.round((Number(maxOffset) || 0) * source.scaleX)));
        var rangeY = Math.max(0, Math.min(18, Math.round((Number(maxOffset) || 0) * source.scaleY)));
        var best = { score: Infinity, dx: 0, dy: 0, samples: 0 };
        var second = Infinity;
        for (var dy = -rangeY; dy <= rangeY; dy++) {
            for (var dx = -rangeX; dx <= rangeX; dx++) {
                var total = 0;
                var weight = 0;
                var samples = 0;
                for (var y = 2; y < height - 2; y += 2) {
                    var ry = y + dy;
                    if (ry < 1 || ry >= height - 1) continue;
                    for (var x = 2; x < width - 2; x += 2) {
                        var rx = x + dx;
                        if (rx < 1 || rx >= width - 1) continue;
                        var a = source.edge[y * source.width + x];
                        var b = reference.edge[ry * reference.width + rx];
                        var localWeight = 8 + Math.max(a, b);
                        total += Math.abs(a - b) * localWeight;
                        weight += localWeight;
                        samples++;
                    }
                }
                var score = weight > 0 ? total / weight / 255 : Infinity;
                if (score < best.score) {
                    second = best.score;
                    best = { score: score, dx: dx, dy: dy, samples: samples };
                } else if (score < second) {
                    second = score;
                }
            }
        }
        var gap = Number.isFinite(second) ? Math.max(0, second - best.score) : 0;
        var confidence = Math.max(0, Math.min(1, (1 - best.score * 2.2) * 0.75 + Math.min(0.25, gap * 8)));
        return {
            dx: best.dx / Math.max(1e-6, source.scaleX),
            dy: best.dy / Math.max(1e-6, source.scaleY),
            confidence: confidence,
            score: best.score,
            samples: best.samples,
            backend: 'cpu-sobel-translation'
        };
    }

    function sampleBilinearRgba(data, width, height, x, y, target, offset) {
        var safeX = Math.max(0, Math.min(width - 1, x));
        var safeY = Math.max(0, Math.min(height - 1, y));
        var x0 = Math.floor(safeX);
        var y0 = Math.floor(safeY);
        var x1 = Math.min(width - 1, x0 + 1);
        var y1 = Math.min(height - 1, y0 + 1);
        var fx = safeX - x0;
        var fy = safeY - y0;
        var p00 = (y0 * width + x0) * 4;
        var p10 = (y0 * width + x1) * 4;
        var p01 = (y1 * width + x0) * 4;
        var p11 = (y1 * width + x1) * 4;
        for (var channel = 0; channel < 4; channel++) {
            var top = data[p00 + channel] + (data[p10 + channel] - data[p00 + channel]) * fx;
            var bottom = data[p01 + channel] + (data[p11 + channel] - data[p01 + channel]) * fx;
            target[offset + channel] = Math.round(top + (bottom - top) * fy);
        }
    }

    function alignReference(referenceImageData, dx, dy) {
        var width = referenceImageData.width;
        var height = referenceImageData.height;
        var aligned = new Uint8ClampedArray(referenceImageData.data.length);
        for (var y = 0; y < height; y++) {
            for (var x = 0; x < width; x++) {
                sampleBilinearRgba(referenceImageData.data, width, height, x + dx, y + dy, aligned, (y * width + x) * 4);
            }
        }
        return aligned;
    }

    function computeSharedContentMask(output, reference, width, height, featherRadius) {
        var count = width * height;
        var mask = new Float32Array(count);
        var shared = 0;
        for (var y = 1; y < height - 1; y++) {
            for (var x = 1; x < width - 1; x++) {
                var index = y * width + x;
                var offset = index * 4;
                if (output[offset + 3] < 12 || reference[offset + 3] < 12) continue;
                var outDx = Math.abs(pixelLuma(output, offset + 4) - pixelLuma(output, offset - 4));
                var refDx = Math.abs(pixelLuma(reference, offset + 4) - pixelLuma(reference, offset - 4));
                var outDy = Math.abs(pixelLuma(output, offset + width * 4) - pixelLuma(output, offset - width * 4));
                var refDy = Math.abs(pixelLuma(reference, offset + width * 4) - pixelLuma(reference, offset - width * 4));
                var structuralDelta = Math.abs(outDx - refDx) + Math.abs(outDy - refDy);
                var value = Math.max(0, Math.min(1, 1 - structuralDelta / 72));
                mask[index] = value;
                if (value > 0.25) shared++;
            }
        }
        var radius = Math.max(0, Math.min(24, Math.round(Number(featherRadius) || 0)));
        if (radius > 0) {
            var temporary = new Float32Array(count);
            blurHorizontal(mask, temporary, width, height, radius);
            blurVertical(temporary, mask, width, height, radius);
        }
        return { mask: mask, sharedRatio: shared / Math.max(1, count) };
    }

    function normalizeMatchOptions(methodOrOptions) {
        var source = methodOrOptions && typeof methodOrOptions === 'object'
            ? methodOrOptions
            : { method: methodOrOptions };
        var strength = Number(source.strength == null ? source.totalStrength : source.strength);
        if (!Number.isFinite(strength)) strength = 100;
        return {
            method: source.method === 'reinhard' ? 'reinhard' : 'wavelet',
            strength: Math.max(0, Math.min(100, strength)),
            preserveAlpha: source.preserveAlpha !== false,
            alignmentEnabled: source.alignmentEnabled !== false,
            alignmentMaxOffset: Math.max(0, Math.min(160, Number(source.alignmentMaxOffset == null ? 120 : source.alignmentMaxOffset) || 0)),
            featherRadius: Math.max(0, Math.min(128, Number(source.featherRadius == null ? 16 : source.featherRadius) || 0)),
            sharedMaskEnabled: source.sharedMaskEnabled !== false
        };
    }

    function blendCorrection(output, original, options, weights) {
        var amount = options.strength / 100;
        if (amount >= 1 && !weights) return;
        for (var i = 0; i < output.length; i += 4) {
            var alphaWeight = options.preserveAlpha ? original[i + 3] / 255 : 1;
            var mixAmount = amount * alphaWeight * (weights ? weights[i / 4] : 1);
            output[i] = Math.round(original[i] + (output[i] - original[i]) * mixAmount);
            output[i + 1] = Math.round(original[i + 1] + (output[i + 1] - original[i + 1]) * mixAmount);
            output[i + 2] = Math.round(original[i + 2] + (output[i + 2] - original[i + 2]) * mixAmount);
            output[i + 3] = original[i + 3];
        }
    }

    function createImageDataLike(data, width, height) {
        if (typeof ImageData === 'function') return new ImageData(data, width, height);
        return { data: data, width: width, height: height };
    }

    function matchImageData(inputImageData, outputImageData, methodOrOptions) {
        if (!inputImageData || !inputImageData.data || !outputImageData || !outputImageData.data) {
            throw new Error('融合校色图像数据无效');
        }
        var width = Number(outputImageData.width) || 0;
        var height = Number(outputImageData.height) || 0;
        if (!width || !height || width !== Number(inputImageData.width) || height !== Number(inputImageData.height)) {
            throw new Error('融合校色图像尺寸不一致');
        }
        var options = normalizeMatchOptions(methodOrOptions);
        var output = new Uint8ClampedArray(outputImageData.data);
        var original = new Uint8ClampedArray(output);
        var alignment = options.alignmentEnabled
            ? estimateTranslation(outputImageData, inputImageData, options.alignmentMaxOffset)
            : { dx: 0, dy: 0, confidence: 1, score: 0, samples: 0, backend: 'disabled' };
        var input = options.alignmentEnabled
            ? alignReference(inputImageData, alignment.dx, alignment.dy)
            : new Uint8ClampedArray(inputImageData.data);
        var shared = options.sharedMaskEnabled
            ? computeSharedContentMask(original, input, width, height, options.featherRadius)
            : { mask: null, sharedRatio: 1 };
        if (options.method === 'reinhard') applyReinhard(output, input, width * height, shared.mask);
        else applyWavelet(output, input, width, height);
        blendCorrection(output, original, options, shared.mask);
        var result = createImageDataLike(output, width, height);
        var analysis = {
            alignment: alignment,
            sharedRatio: shared.sharedRatio,
            method: options.method,
            strength: options.strength,
            featherRadius: options.featherRadius
        };
        try { result.analysis = analysis; } catch (ignoreAnalysisAttachmentError) {}
        return result;
    }

    function crc32(bytes, start, length) {
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (var n = 0; n < 256; n++) {
                var c = n;
                for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
                crcTable[n] = c;
            }
        }
        var crc = 0xFFFFFFFF;
        for (var i = start; i < start + length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function injectSrgbChunk(png) {
        if (!png || png.length < 33) return png;
        var signature = [137, 80, 78, 71, 13, 10, 26, 10];
        for (var i = 0; i < 8; i++) if (png[i] !== signature[i]) return png;
        var ihdrLength = ((png[8] << 24) | (png[9] << 16) | (png[10] << 8) | png[11]) >>> 0;
        var ihdrEnd = 8 + 4 + 4 + ihdrLength + 4;
        for (var offset = ihdrEnd; offset + 12 <= png.length;) {
            var length = ((png[offset] << 24) | (png[offset + 1] << 16) | (png[offset + 2] << 8) | png[offset + 3]) >>> 0;
            var type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
            if (type === 'sRGB' || type === 'iCCP') return png;
            if (type === 'IDAT' || type === 'IEND') break;
            offset += 12 + length;
        }
        var chunk = new Uint8Array(13);
        chunk.set([0, 0, 0, 1, 115, 82, 71, 66, 0]);
        var crc = crc32(chunk, 4, 5);
        chunk[9] = (crc >>> 24) & 255;
        chunk[10] = (crc >>> 16) & 255;
        chunk[11] = (crc >>> 8) & 255;
        chunk[12] = crc & 255;
        var result = new Uint8Array(png.length + chunk.length);
        result.set(png.subarray(0, ihdrEnd), 0);
        result.set(chunk, ihdrEnd);
        result.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
        return result;
    }

    function dataUrlToBytes(dataUrl) {
        var comma = dataUrl.indexOf(',');
        var binary = atob(dataUrl.slice(comma + 1));
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function bytesToPngDataUrl(bytes) {
        var chunks = [];
        for (var i = 0; i < bytes.length; i += 8192) {
            chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
        }
        return 'data:image/png;base64,' + btoa(chunks.join(''));
    }

    function addSrgbProfile(dataUrl) {
        if (!/^data:image\/png;base64,/i.test(dataUrl || '')) return dataUrl;
        return bytesToPngDataUrl(injectSrgbChunk(dataUrlToBytes(dataUrl)));
    }

    function normalizeToSrgbPng(dataUrl) {
        return loadImage(dataUrl).then(function(image) {
            var canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth || image.width;
            canvas.height = image.naturalHeight || image.height;
            var context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return addSrgbProfile(canvas.toDataURL('image/png'));
        });
    }

    function matchDataUrls(inputDataUrl, outputDataUrl, methodOrOptions) {
        return Promise.all([loadImage(outputDataUrl), loadImage(inputDataUrl)]).then(function(images) {
            var outputImage = images[0];
            var inputImage = images[1];
            var width = outputImage.naturalWidth || outputImage.width;
            var height = outputImage.naturalHeight || outputImage.height;
            if (!width || !height) throw new Error('图片尺寸异常');
            var canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            var context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(outputImage, 0, 0, width, height);
            var outputData = context.getImageData(0, 0, width, height);
            context.clearRect(0, 0, width, height);
            context.drawImage(inputImage, 0, 0, width, height);
            var inputData = context.getImageData(0, 0, width, height);
            var corrected = matchImageData(inputData, outputData, methodOrOptions);
            context.putImageData(corrected, 0, 0);
            return addSrgbProfile(canvas.toDataURL('image/png'));
        });
    }

    global.HuanmengColorMatch = {
        matchDataUrls: matchDataUrls,
        matchImageData: matchImageData,
        inspectDataUrl: inspectDataUrl,
        normalizeMatchOptions: normalizeMatchOptions,
        normalizeToSrgbPng: normalizeToSrgbPng,
        addSrgbProfile: addSrgbProfile,
        injectSrgbChunk: injectSrgbChunk,
        estimateTranslation: estimateTranslation,
        computeSharedContentMask: computeSharedContentMask
    };
})(window);
