// Raw PCM (what some speech models return, such as Gemini TTS) can't be played
// by a browser's <audio>. Wrapping it in a WAV header makes it playable.

// Sample rate from a content type like "audio/pcm;rate=24000", else the default
function pcmRate(contentType, fallback = 24000) {
    const m = /(?:rate|sample[-_]?rate)=(\d+)/i.exec(contentType || '');
    return m ? parseInt(m[1], 10) : fallback;
}

// 16-bit little-endian mono PCM -> WAV
function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);            // fmt chunk size
    header.writeUInt16LE(1, 20);             // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(channels * bitsPerSample / 8, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

module.exports = { pcmRate, pcmToWav };
