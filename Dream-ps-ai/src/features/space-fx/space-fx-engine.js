(function(global) {
    'use strict';

    const PRESETS = {
        heat: {
            effect: 'heat',
            label: '热浪',
            intensity: 48,
            range: 62,
            feather: 54,
            angle: 90,
            detail: 58,
            glow: 12,
            glowColor: '#ffd27a',
            glowColorAmount: 28,
            glowColorEnabled: true,
            brush: 42
        },
        airflow: {
            effect: 'airflow',
            label: '气流',
            intensity: 34,
            range: 78,
            feather: 76,
            angle: 0,
            detail: 48,
            glow: 38,
            glowColor: '#9fdcff',
            glowColorAmount: 64,
            glowColorEnabled: true,
            brush: 78
        },
        slash: {
            effect: 'slash',
            label: '刀光',
            intensity: 56,
            range: 72,
            feather: 38,
            angle: -24,
            detail: 54,
            glow: 56,
            glowColor: '#7ddfff',
            glowColorAmount: 64,
            glowColorEnabled: true,
            brush: 34
        }
    };

    function clamp(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback == null ? min : fallback;
        return Math.min(max, Math.max(min, number));
    }

    function mix(from, to, amount) {
        return from + (to - from) * amount;
    }

    function smoothstep(edge0, edge1, value) {
        const width = Math.max(1e-5, edge1 - edge0);
        const amount = clamp((value - edge0) / width, 0, 1, 0);
        return amount * amount * (3 - 2 * amount);
    }

    function hashNoise(x, y) {
        const value = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
        return value - Math.floor(value);
    }

    function valueNoise(x, y) {
        const left = Math.floor(x);
        const top = Math.floor(y);
        const fx = smoothstep(0, 1, x - left);
        const fy = smoothstep(0, 1, y - top);
        const a = hashNoise(left, top);
        const b = hashNoise(left + 1, top);
        const c = hashNoise(left, top + 1);
        const d = hashNoise(left + 1, top + 1);
        return mix(mix(a, b, fx), mix(c, d, fx), fy);
    }

    function fractalNoise(x, y) {
        let result = 0;
        let amplitude = 0.55;
        let frequency = 1;
        let total = 0;
        for (let octave = 0; octave < 4; octave++) {
            result += valueNoise(x * frequency, y * frequency) * amplitude;
            total += amplitude;
            amplitude *= 0.5;
            frequency *= 2.07;
        }
        return total ? result / total : 0;
    }

    function parseHexColor(value, fallback) {
        const match = String(value || '').trim().match(/^#?([0-9a-f]{6})$/i);
        if (!match) return (fallback || [125, 223, 255]).slice();
        const number = parseInt(match[1], 16);
        return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
    }

    function normalizeSettings(settings) {
        const source = settings && typeof settings === 'object' ? settings : {};
        const effect = PRESETS[source.effect] ? source.effect : 'heat';
        const preset = PRESETS[effect];
        return {
            effect: effect,
            label: preset.label,
            intensity: clamp(source.intensity, 0, 100, preset.intensity),
            range: clamp(source.range, 10, 100, preset.range),
            feather: clamp(source.feather, 0, 100, preset.feather),
            angle: clamp(source.angle, -180, 180, preset.angle),
            detail: clamp(source.detail, 0, 100, preset.detail),
            glow: clamp(source.glow, 0, 100, preset.glow),
            glowColor: String(source.glowColor || preset.glowColor),
            glowColorAmount: clamp(source.glowColorAmount, 0, 100, preset.glowColorAmount),
            glowColorEnabled: source.glowColorEnabled !== false,
            brush: clamp(source.brush, 8, 120, preset.brush),
            centerX: clamp(source.centerX, 0, 1, 0.5),
            centerY: clamp(source.centerY, 0, 1, 0.5)
        };
    }

    function preset(name) {
        const value = PRESETS[name] || PRESETS.heat;
        return Object.assign({}, value);
    }

    function sampleBilinear(data, width, height, x, y, output) {
        const safeX = clamp(x, 0, width - 1, 0);
        const safeY = clamp(y, 0, height - 1, 0);
        const x0 = Math.floor(safeX);
        const y0 = Math.floor(safeY);
        const x1 = Math.min(width - 1, x0 + 1);
        const y1 = Math.min(height - 1, y0 + 1);
        const fx = safeX - x0;
        const fy = safeY - y0;
        const p00 = (y0 * width + x0) * 4;
        const p10 = (y0 * width + x1) * 4;
        const p01 = (y1 * width + x0) * 4;
        const p11 = (y1 * width + x1) * 4;
        for (let channel = 0; channel < 4; channel++) {
            output[channel] = mix(
                mix(data[p00 + channel], data[p10 + channel], fx),
                mix(data[p01 + channel], data[p11 + channel], fx),
                fy
            );
        }
    }

    function screen(base, light) {
        return 255 - (255 - base) * (255 - light) / 255;
    }

    function createImageDataLike(data, width, height) {
        if (typeof ImageData === 'function') return new ImageData(data, width, height);
        return { data: data, width: width, height: height };
    }

    function render(sourceImageData, rawSettings) {
        if (!sourceImageData || !sourceImageData.data || !sourceImageData.width || !sourceImageData.height) {
            throw new Error('空间特效源图像无效');
        }

        const settings = normalizeSettings(rawSettings);
        const width = Math.max(1, Math.round(sourceImageData.width));
        const height = Math.max(1, Math.round(sourceImageData.height));
        const source = sourceImageData.data;
        const output = new Uint8ClampedArray(source.length);
        const displacement = new Uint8ClampedArray(source.length);
        const radians = settings.angle * Math.PI / 180;
        const dirX = Math.cos(radians);
        const dirY = Math.sin(radians);
        const normalX = -dirY;
        const normalY = dirX;
        const centerX = settings.centerX * (width - 1);
        const centerY = settings.centerY * (height - 1);
        const maxEdge = Math.max(width, height);
        const minEdge = Math.min(width, height);
        const coreRadius = minEdge * (0.02 + settings.range / 100 * 0.12 + settings.brush / 120 * 0.08);
        const outerRadius = coreRadius * (1.4 + settings.feather / 100 * 3.5);
        const intensityPx = Math.min(coreRadius * 0.42, maxEdge * (0.002 + settings.intensity / 100 * 0.026));
        const detail = settings.detail / 100;
        const glow = settings.glow / 100;
        const effectBaseColor = settings.effect === 'heat' ? [255, 210, 135]
            : settings.effect === 'airflow' ? [170, 220, 255]
            : [125, 223, 255];
        const pickedGlowColor = parseHexColor(settings.glowColor, effectBaseColor);
        const colorMix = settings.glowColorEnabled ? settings.glowColorAmount / 100 : 0;
        const glowColor = effectBaseColor.map(function(channel, index) {
            return mix(channel, pickedGlowColor[index], colorMix);
        });
        const sample = [0, 0, 0, 0];

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const dx = x - centerX;
                const dy = y - centerY;
                const along = dx * dirX + dy * dirY;
                const across = dx * normalX + dy * normalY;
                const band = 1 - smoothstep(coreRadius * 0.18, outerRadius, Math.abs(across));
                const lengthFalloff = 1 - smoothstep(maxEdge * 0.32, maxEdge * 0.82, Math.abs(along));
                const mask = clamp(band * (0.3 + 0.7 * lengthFalloff), 0, 1, 0);
                const noiseScale = 0.018 + detail * 0.055;
                const noise = (fractalNoise(x * noiseScale + 4.3, y * noiseScale - 2.7) - 0.5) * 2;
                const wave = Math.sin(along * (0.035 + detail * 0.085) + noise * 3.2);
                let acrossShift = (wave * 0.64 + noise * 0.48) * intensityPx * mask;
                let alongShift = noise * intensityPx * 0.18 * mask;

                if (settings.effect === 'airflow') {
                    acrossShift *= 0.52;
                    alongShift += wave * intensityPx * 0.42 * mask;
                } else if (settings.effect === 'slash') {
                    acrossShift *= 0.28;
                    alongShift += (0.35 + noise * 0.25) * intensityPx * mask;
                }

                const sourceX = x - normalX * acrossShift - dirX * alongShift;
                const sourceY = y - normalY * acrossShift - dirY * alongShift;
                sampleBilinear(source, width, height, sourceX, sourceY, sample);
                const index = (y * width + x) * 4;
                const line = Math.pow(1 - smoothstep(0, Math.max(1, coreRadius * 0.38), Math.abs(across)), 2.2);
                const shimmer = clamp(line * mask * glow * (0.36 + 0.64 * Math.max(0, wave)), 0, 1, 0);

                for (let channel = 0; channel < 3; channel++) {
                    const lit = screen(sample[channel], glowColor[channel] * shimmer);
                    output[index + channel] = Math.round(mix(sample[channel], lit, shimmer));
                }
                output[index + 3] = Math.round(sample[3]);

                const mapX = clamp(128 + acrossShift / Math.max(1, intensityPx) * 110, 0, 255, 128);
                const mapY = clamp(128 + alongShift / Math.max(1, intensityPx) * 110, 0, 255, 128);
                displacement[index] = Math.round(mapX);
                displacement[index + 1] = Math.round(mapY);
                displacement[index + 2] = Math.round(mask * 255);
                displacement[index + 3] = 255;
            }
        }

        return {
            imageData: createImageDataLike(output, width, height),
            displacementMap: createImageDataLike(displacement, width, height),
            settings: settings
        };
    }

    global.HuanmengSpaceFx = {
        PRESETS: PRESETS,
        normalizeSettings: normalizeSettings,
        preset: preset,
        render: render
    };
})(window);
