// Stop hook: reads Claude's last reply aloud when GRILL_VOICE is set.
// Start a voice session with:  $env:GRILL_VOICE=1; claude
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

if (!process.env.GRILL_VOICE) process.exit(0);

// Never fail the hook: speech is a nice-to-have, errors would surface in every session.
try {
    speak();
} catch {}
process.exit(0);

function speak() {
    const { transcript_path } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const entries = fs.readFileSync(transcript_path, 'utf8')
      .trim()
      .split('\n')
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    const text = entries.reverse()
      .filter(e => e.type === 'assistant')
      .flatMap(e => (e.message?.content || []).filter(b => b.type === 'text').map(b => b.text))[0];
    if (!text) return;

    const plain = text
      .replace(/```[\s\S]*?```/g, ' code omitted. ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_#>|]/g, '');

    // Stop any speech still playing from the previous reply.
    const pidFile = path.join(os.tmpdir(), 'grill-speak.pid');
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch {}

    const textFile = path.join(os.tmpdir(), 'grill-speak.txt');
    fs.writeFileSync(textFile, plain);

    const child = spawn('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak((Get-Content -Raw -Encoding UTF8 '${textFile}'))`],
      { detached: true, stdio: 'ignore', windowsHide: true });
    fs.writeFileSync(pidFile, String(child.pid));
    child.unref();
}
