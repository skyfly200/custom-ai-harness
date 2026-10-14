const test = require('node:test');
const assert = require('node:assert/strict');
const { pcmRate, pcmToWav } = require('../utils/audio');

test('raw PCM gets a WAV header a browser can play', () => {
    const pcm = Buffer.alloc(480, 1);
    const wav = pcmToWav(pcm, { sampleRate: 24000 });
    assert.equal(wav.length, 44 + 480);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 24000);       // sample rate
    assert.equal(wav.readUInt32LE(28), 48000);       // bytes per second, 16-bit mono
    assert.equal(wav.readUInt32LE(40), 480);         // data size
});

test('the PCM sample rate comes from the content type when given', () => {
    assert.equal(pcmRate('audio/pcm;rate=16000'), 16000);
    assert.equal(pcmRate('audio/L16; sample_rate=44100'), 44100);
    assert.equal(pcmRate('audio/pcm'), 24000);
});
