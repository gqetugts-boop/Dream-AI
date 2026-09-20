'use strict';

const assert = require('node:assert/strict');

global.window = global;
global.document = {
    createElement: function() {
        return {
            width: 0,
            height: 0,
            getContext: function() {
                return {
                    createImageData: function(width, height) {
                        return { width: width, height: height, data: new Uint8ClampedArray(width * height * 4) };
                    }
                };
            }
        };
    }
};
require('../src/features/color-match/color-match.service.js');
require('../src/features/glow/glow-engine.js');
require('../src/features/space-fx/space-fx-engine.js');

function makeImage(width, height, pixel) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        const value = pixel(index % width, Math.floor(index / width));
        data[offset] = value[0];
        data[offset + 1] = value[1];
        data[offset + 2] = value[2];
        data[offset + 3] = value.length > 3 ? value[3] : 255;
    }
    return { width, height, data };
}

const reference = makeImage(16, 12, (x, y) => [40 + x * 4, 70 + y * 3, 120, 255]);
const returned = makeImage(16, 12, (x, y) => [150 + x, 40 + y * 2, 55, x === 0 ? 128 : 255]);
const returnedCopy = new Uint8ClampedArray(returned.data);

const zeroStrength = global.HuanmengColorMatch.matchImageData(reference, returned, {
    method: 'wavelet',
    strength: 0
});
assert.deepEqual(Array.from(zeroStrength.data), Array.from(returned.data), '0% strength must preserve the returned image');

const corrected = global.HuanmengColorMatch.matchImageData(reference, returned, {
    method: 'reinhard',
    strength: 100
});
assert.equal(corrected.width, returned.width);
assert.equal(corrected.height, returned.height);
assert.notDeepEqual(Array.from(corrected.data), Array.from(returned.data), '100% correction should change color samples');
assert.equal(corrected.data[3], returned.data[3], 'color correction must preserve alpha');
assert.deepEqual(Array.from(returned.data), Array.from(returnedCopy), 'color correction must not mutate its input');

const alignmentReference = makeImage(64, 48, (x, y) => {
    const block = x >= 16 && x < 38 && y >= 12 && y < 34;
    const stripe = Math.abs(x - y) < 3;
    return block ? [235, 210, 80, 255] : (stripe ? [40, 210, 245, 255] : [22, 28, 38, 255]);
});
const alignmentOutput = makeImage(64, 48, (x, y) => {
    const sourceX = x - 3;
    const sourceY = y + 2;
    if (sourceX < 0 || sourceY < 0 || sourceX >= 64 || sourceY >= 48) return [22, 28, 38, 255];
    const offset = (sourceY * 64 + sourceX) * 4;
    return [
        alignmentReference.data[offset],
        alignmentReference.data[offset + 1],
        alignmentReference.data[offset + 2],
        255
    ];
});
const alignment = global.HuanmengColorMatch.estimateTranslation(alignmentOutput, alignmentReference, 12);
assert.ok(Math.abs(alignment.dx + 3) <= 1.5, 'Sobel alignment should recover horizontal translation');
assert.ok(Math.abs(alignment.dy - 2) <= 1.5, 'Sobel alignment should recover vertical translation');
assert.ok(alignment.confidence > 0.2, 'alignment should report usable confidence');

const spaceSource = makeImage(24, 18, (x, y) => [x * 9, y * 11, 80 + x, 255]);
const sourceCopy = new Uint8ClampedArray(spaceSource.data);
const spaceResult = global.HuanmengSpaceFx.render(spaceSource, {
    effect: 'heat',
    intensity: 72,
    range: 64,
    feather: 58,
    angle: 35,
    detail: 70,
    glow: 40,
    glowColor: '#ff8844',
    centerX: 0.45,
    centerY: 0.55
});
assert.equal(spaceResult.imageData.data.length, spaceSource.data.length);
assert.equal(spaceResult.displacementMap.data.length, spaceSource.data.length);
assert.notDeepEqual(Array.from(spaceResult.imageData.data), Array.from(spaceSource.data), 'space effect should alter pixels');
assert.deepEqual(Array.from(spaceSource.data), Array.from(sourceCopy), 'space effect must not mutate its input');
assert.equal(global.HuanmengSpaceFx.preset('airflow').effect, 'airflow');

const glowSource = makeImage(20, 14, (x, y) => {
    const highlight = x > 7 && x < 13 && y > 4 && y < 10 ? 245 : 35;
    return [highlight, Math.max(20, highlight - 15), Math.max(18, highlight - 40), 255];
});
const glowCopy = new Uint8ClampedArray(glowSource.data);
// 参数必须用引擎的 UI 单位：strength 0-100、threshold 0-100、radius 1-500、colorHex。
// 旧用例传的 intensity/color 引擎不读，threshold 0.62 被当成 0.62/100，等于没测参数。
const glowResult = global.GlowEngine.createPreview(glowSource, {
    style: 'soft',
    strength: 85,
    threshold: 62,
    radius: 10,
    colorHex: '#ffd6a0',
    colorAmount: 100
}, true);
assert.equal(glowResult.previewImageData.data.length, glowSource.data.length);
assert.equal(glowResult.glowLayerImageData.data.length, glowSource.data.length);
assert.notDeepEqual(Array.from(glowResult.previewImageData.data), Array.from(glowSource.data), 'glow preview should alter highlights');
assert.deepEqual(Array.from(glowSource.data), Array.from(glowCopy), 'glow engine must not mutate its input');

// 参数保真：确认 UI 参数真的进了 composite，而不是被静默忽略
assert.equal(glowResult.params.composite.colorAmount, 1, 'colorAmount 100 must reach composite as 1');
assert.deepEqual(
    [glowResult.params.composite.colorTint.r, glowResult.params.composite.colorTint.g, glowResult.params.composite.colorTint.b]
        .map(v => Math.round(v * 255)),
    [255, 214, 160],
    'colorHex #ffd6a0 must reach composite.colorTint'
);
assert.ok(glowResult.params.blur && glowResult.params.blur.mipCount > 0, 'radius must produce a mip pyramid');

// strength 0 必须显著弱于 strength 100（同一张图、其余参数一致）
function glowEnergy(strength) {
    const out = global.GlowEngine.createPreview(glowSource, {
        style: 'soft', strength: strength, threshold: 62, radius: 10
    }, true);
    let sum = 0;
    for (let i = 0; i < out.glowLayerImageData.data.length; i += 4) sum += out.glowLayerImageData.data[i];
    return sum;
}
assert.ok(glowEnergy(0) < glowEnergy(100), 'strength 0 must glow less than strength 100');

console.log('feature services: ok');
