import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const MODEL_DIR = path.join(
  os.homedir(),
  ".claude-assistant",
  "tts-models",
  "kokoro-en-v0_19"
);

// Kokoro English voice name → speaker ID mapping
export const KOKORO_VOICES: Record<string, number> = {
  af_heart: 0,
  af_bella: 1,
  af_nicole: 2,
  af_sarah: 3,
  af_sky: 4,
  am_adam: 5,
  am_michael: 6,
  bf_emma: 7,
  bf_isabella: 8,
  bm_george: 9,
  bm_lewis: 10,
};

let sherpaOnnx: any = null;
let ttsInstance: any = null;

function loadSherpaOnnx(): any {
  if (!sherpaOnnx) {
    try {
      sherpaOnnx = require("sherpa-onnx-node");
    } catch (e) {
      console.error("[KokoroTTS] Failed to load sherpa-onnx-node:", e);
      return null;
    }
  }
  return sherpaOnnx;
}

export function isKokoroAvailable(): boolean {
  return fs.existsSync(path.join(MODEL_DIR, "model.onnx"));
}

function ensureInitialized(): boolean {
  if (ttsInstance) return true;

  const so = loadSherpaOnnx();
  if (!so) return false;

  if (!isKokoroAvailable()) {
    console.warn("[KokoroTTS] Model not found at", MODEL_DIR);
    return false;
  }

  try {
    console.log("[KokoroTTS] Loading Kokoro model...");
    const config = {
      model: {
        kokoro: {
          model: path.join(MODEL_DIR, "model.onnx"),
          voices: path.join(MODEL_DIR, "voices.bin"),
          tokens: path.join(MODEL_DIR, "tokens.txt"),
          dataDir: path.join(MODEL_DIR, "espeak-ng-data"),
          lengthScale: 1.0,
        },
      },
      numThreads: 2,
      provider: "cpu",
      maxNumSentences: 2,
    };
    ttsInstance = new so.OfflineTts(config);
    console.log(`[KokoroTTS] Model loaded — ${ttsInstance.numSpeakers} speakers, ${ttsInstance.sampleRate}Hz`);
    return true;
  } catch (e) {
    console.error("[KokoroTTS] Failed to initialize:", e);
    return false;
  }
}

/**
 * Generate WAV audio from text using Kokoro TTS.
 * Returns a Buffer containing the WAV file, or null on failure.
 */
export function generateKokoroAudio(
  text: string,
  voice: string = "af_heart",
  speed: number = 1.0
): Buffer | null {
  if (!ensureInitialized()) return null;

  const so = loadSherpaOnnx();
  const sid = KOKORO_VOICES[voice] ?? 0;
  try {
    const audio = ttsInstance.generate({ text, sid, speed });
    const tmpPath = `/tmp/kokoro_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`;
    so.writeWave(tmpPath, { samples: audio.samples, sampleRate: audio.sampleRate });
    const wavBuffer = fs.readFileSync(tmpPath);
    fs.unlinkSync(tmpPath);
    return wavBuffer;
  } catch (e) {
    console.error("[KokoroTTS] Generation failed:", e);
    return null;
  }
}

export function freeKokoroTts(): void {
  ttsInstance = null;
}
