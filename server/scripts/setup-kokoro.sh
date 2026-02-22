#!/bin/bash
# Downloads the Kokoro English TTS model for sherpa-onnx
# Model: kokoro-en-v0_19 (~330MB download)

MODEL_DIR="$HOME/.claude-assistant/tts-models"
MODEL_NAME="kokoro-en-v0_19"
DOWNLOAD_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${MODEL_NAME}.tar.bz2"

mkdir -p "$MODEL_DIR"

if [ -f "$MODEL_DIR/$MODEL_NAME/model.onnx" ]; then
  echo "Kokoro model already installed at $MODEL_DIR/$MODEL_NAME"
  exit 0
fi

echo "Downloading Kokoro TTS model (~330MB)..."
cd "$MODEL_DIR"
curl -SL --progress-bar -O "$DOWNLOAD_URL"

if [ $? -ne 0 ]; then
  echo "Download failed!"
  exit 1
fi

echo "Extracting..."
tar xf "${MODEL_NAME}.tar.bz2"
rm -f "${MODEL_NAME}.tar.bz2"

if [ -f "$MODEL_DIR/$MODEL_NAME/model.onnx" ]; then
  echo "Kokoro model installed successfully at $MODEL_DIR/$MODEL_NAME"
else
  echo "Extraction failed — model.onnx not found"
  exit 1
fi
