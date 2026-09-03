// Get DOM elements
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const fsBtn = document.getElementById('fsBtn');
const effectSelect = document.getElementById('effectSelect');
const sourceVideo = document.getElementById('sourceVideo');
const effectCanvas = document.getElementById('effectCanvas');
const ctx = effectCanvas.getContext('2d');
const instructionBlock = document.getElementById('instructionBlock');
// Wave panel elements
const wavePanel = document.getElementById('wavePanel');
const ampXInput = document.getElementById('ampX');
const ampYInput = document.getElementById('ampY');
const waveLenXInput = document.getElementById('waveLenX');
const waveLenYInput = document.getElementById('waveLenY');
const speedInput = document.getElementById('speed');
const centeredCheckbox = document.getElementById('centered');
// Display spans
const ampXVal = document.getElementById('ampXVal');
const ampYVal = document.getElementById('ampYVal');
const waveLenXVal = document.getElementById('waveLenXVal');
const waveLenYVal = document.getElementById('waveLenYVal');
const speedVal = document.getElementById('speedVal');

// Update display values function
function updateDisplay() {
  if (ampXVal) ampXVal.textContent = ampXInput.value;
  if (ampYVal) ampYVal.textContent = ampYInput.value;
  if (waveLenXVal) waveLenXVal.textContent = waveLenXInput.value;
  if (waveLenYVal) waveLenYVal.textContent = waveLenYInput.value;
  if (speedVal) speedVal.textContent = speedInput.value;
}

// Attach input listeners to update spans in real time
[ampXInput, ampYInput, waveLenXInput, waveLenYInput, speedInput].forEach(inp => {
  if (inp) {
    inp.addEventListener('input', updateDisplay);
  }
});

// Initialize UI state on page load
function initUI() {
  // Set panel visibility based on initial selected effect
  if (effectSelect.value === 'wave') {
    wavePanel.style.display = 'block';
  } else {
    wavePanel.style.display = 'none';
  }
  // Initialize displayed values
  updateDisplay();
}

// Run initialization after DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}

let mediaStream = null;
let animationFrameId = null;
let startTime = null;

// Start button click handler
  startBtn.addEventListener('click', async () => {
  try {
    // Request screen capture with audio
    mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    
    // Assign the stream to the video element
    sourceVideo.srcObject = mediaStream;
    
    // Wait for video to start playing
      sourceVideo.onplay = () => {
        // Set canvas size to match video dimensions (maintain aspect ratio via CSS)
        effectCanvas.width = sourceVideo.videoWidth;
        effectCanvas.height = sourceVideo.videoHeight;
      
      // Start the animation loop
      startTime = performance.now();
      applyEffect();
      
        // Update UI
        startBtn.disabled = true;
        stopBtn.disabled = false;
        // Hide instruction, show success message
        if (instructionBlock) {
          instructionBlock.textContent = 'Трансляция идёт, смотрите видео с эффектом ниже';
        }
    };
    
    // Handle video ending (if the user stops sharing)
    sourceVideo.onended = stopCapture;
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      alert('Пользователь отменил выбор экрана для захвата.');
    } else {
      alert('Ошибка при захвате экрана: ' + err);
    }
    console.error(err);
  }
});

// Stop button click handler
  stopBtn.addEventListener('click', stopCapture);
  fsBtn.addEventListener('click', toggleFullscreen);

function stopCapture() {
  // Stop animation frame
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  
  // Stop media stream tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  
  // Reset video source
  sourceVideo.srcObject = null;
  
  // Clear canvas
  ctx.clearRect(0, 0, effectCanvas.width, effectCanvas.height);
  
  // Update UI
  startBtn.disabled = false;
  stopBtn.disabled = true;
  // Restore instruction text
  if (instructionBlock) {
    instructionBlock.innerHTML = `Откройте видео в новой вкладке (YouTube, любой плеер).<br>Вернитесь на эту страницу.<br>Нажмите «Начать» и выберите вкладку с видео.<br>После успешного захвата потока будет показано сообщение: «Трансляция идёт, смотрите видео с эффектом ниже».`;
  }
}

function applyEffect() {
  // Draw current video frame to canvas
  ctx.drawImage(sourceVideo, 0, 0, effectCanvas.width, effectCanvas.height);
  
  // Get image data
  const imageData = ctx.getImageData(0, 0, effectCanvas.width, effectCanvas.height);
  const data = imageData.data;
  
  // Time-based effect parameter
  const time = (performance.now() - startTime) / 1000; // in seconds
  
  // Apply selected effect
  switch (effectSelect.value) {
    case 'wave':
      applyWaveEffect(data, effectCanvas.width, effectCanvas.height, time);
      break;
    case 'bulge':
      applyBulgeEffect(data, effectCanvas.width, effectCanvas.height, time);
      break;
    case 'invert':
      applyInvertEffect(data);
      break;
    case 'grayscale':
      applyGrayscaleEffect(data);
      break;
    case 'mirror':
      applyMirrorEffect(data, effectCanvas.width, effectCanvas.height);
      break;
    case 'pixelate':
      applyPixelateEffect(data, effectCanvas.width, effectCanvas.height);
      break;
    case 'twist':
      applyTwistEffect(data, effectCanvas.width, effectCanvas.height, time);
      break;
    case 'ripple':
      applyRippleEffect(data, effectCanvas.width, effectCanvas.height, time);
      break;
  }
  
  // Put modified image data back to canvas
  ctx.putImageData(imageData, 0, 0);
  
  // Request next frame
  animationFrameId = requestAnimationFrame(applyEffect);
}

// Fullscreen handling
function toggleFullscreen() {
  const elem = document.querySelector('.container');
  if (!document.fullscreenElement) {
    elem.requestFullscreen().catch(err => console.error(`Error attempting fullscreen: ${err.message}`));
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('fullscreenchange', () => {
  if (fsBtn) {
    fsBtn.textContent = document.fullscreenElement ? '✖ Свернуть' : '⛶ Во весь экран';
  }
});

function applyWaveEffect(data, width, height, time) {
  // Parameters from UI (fallback to defaults if elements missing)
  const ampX = ampXInput ? parseFloat(ampXInput.value) : 15;
  const ampY = ampYInput ? parseFloat(ampYInput.value) : 15;
  const waveLenX = waveLenXInput ? parseFloat(waveLenXInput.value) : 30;
  const waveLenY = waveLenYInput ? parseFloat(waveLenYInput.value) : 30;
  const speed = speedInput ? parseFloat(speedInput.value) : 1;
  const centered = centeredCheckbox ? centeredCheckbox.checked : false;

  const freqX = 2 * Math.PI / waveLenX;
  const freqY = 2 * Math.PI / waveLenY;
  const t = time * speed;

  const originalData = new Uint8ClampedArray(data);
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.min(cx, cy);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offsetX = ampX * Math.sin(y * freqY + t);
      const offsetY = ampY * Math.cos(x * freqX + t);
      let srcX = Math.round(x + offsetX);
      let srcY = Math.round(y + offsetY);
      if (centered) {
        const r = Math.hypot(x - cx, y - cy);
        const factor = Math.max(0, 1 - r / maxR);
        srcX = Math.round(x + offsetX * factor);
        srcY = Math.round(y + offsetY * factor);
      }
      srcX = Math.min(Math.max(srcX, 0), width - 1);
      srcY = Math.min(Math.max(srcY, 0), height - 1);
      const srcIdx = (srcY * width + srcX) * 4;
      const destIdx = (y * width + x) * 4;
      data[destIdx] = originalData[srcIdx];
      data[destIdx + 1] = originalData[srcIdx + 1];
      data[destIdx + 2] = originalData[srcIdx + 2];
      data[destIdx + 3] = originalData[srcIdx + 3];
    }
  }
}

function applyBulgeEffect(data, width, height, time) {
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(centerX, centerY) * 0.8; // bulge radius
  const strength = 0.5 + 0.5 * Math.sin(time); // animate bulge strength
  
  // Create temporary buffer for original pixel data
  const originalData = new Uint8ClampedArray(data);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Calculate distance from center
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Calculate bulge factor
      let bulgeFactor = 1;
      if (distance < radius) {
        const normalizedDistance = distance / radius;
        bulgeFactor = 1 - strength * (1 - Math.cos(normalizedDistance * Math.PI / 2));
      }
      
      // Calculate source coordinates
      const sourceX = centerX + dx * bulgeFactor;
      const sourceY = centerY + dy * bulgeFactor;
      
      // Clamp to image bounds
      const clampedX = Math.min(Math.max(Math.round(sourceX), 0), width - 1);
      const clampedY = Math.min(Math.max(Math.round(sourceY), 0), height - 1);
      
      // Get pixel index for source and destination
      const sourceIndex = (clampedY * width + clampedX) * 4;
      const destIndex = (y * width + x) * 4;
      
      // Copy RGBA values from source to destination
      data[destIndex] = originalData[sourceIndex];     // R
      data[destIndex + 1] = originalData[sourceIndex + 1]; // G
      data[destIndex + 2] = originalData[sourceIndex + 2]; // B
      data[destIndex + 3] = originalData[sourceIndex + 3]; // A
    }
  }
}

function applyInvertEffect(data) {
  for (let i = 0; i < data.length; i += 4) {
    // Invert RGB channels
    data[i] = 255 - data[i];     // R
    data[i + 1] = 255 - data[i + 1]; // G
    data[i + 2] = 255 - data[i + 2]; // B
    // Alpha channel remains unchanged
  }
}

// Grayscale effect
function applyGrayscaleEffect(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = data[i + 1] = data[i + 2] = gray;
  }
}

// Mirror horizontally effect
function applyMirrorEffect(data, width, height) {
  const original = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcX = width - 1 - x;
      const srcIndex = (y * width + srcX) * 4;
      const destIndex = (y * width + x) * 4;
      data[destIndex] = original[srcIndex];
      data[destIndex + 1] = original[srcIndex + 1];
      data[destIndex + 2] = original[srcIndex + 2];
      data[destIndex + 3] = original[srcIndex + 3];
    }
  }
}

// Pixelate effect (block size 10)
function applyPixelateEffect(data, width, height) {
  const blockSize = 10;
  const original = new Uint8ClampedArray(data);
  for (let by = 0; by < height; by += blockSize) {
    for (let bx = 0; bx < width; bx += blockSize) {
      // Compute average color within block
      let r = 0, g = 0, b = 0, count = 0;
      for (let y = by; y < Math.min(by + blockSize, height); y++) {
        for (let x = bx; x < Math.min(bx + blockSize, width); x++) {
          const idx = (y * width + x) * 4;
          r += original[idx];
          g += original[idx + 1];
          b += original[idx + 2];
          count++;
        }
      }
      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      // Fill block with average color
      for (let y = by; y < Math.min(by + blockSize, height); y++) {
        for (let x = bx; x < Math.min(bx + blockSize, width); x++) {
          const idx = (y * width + x) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          // keep original alpha
          data[idx + 3] = original[idx + 3];
        }
      }
    }
  }
}

// Twist effect
function applyTwistEffect(data, width, height, time) {
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(cx, cy);
  const twistFactor = Math.PI * 2; // full rotation
  const original = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      const angle = twistFactor * (1 - r / maxRadius) * Math.sin(time);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const srcX = Math.round(cx + dx * cos - dy * sin);
      const srcY = Math.round(cy + dx * sin + dy * cos);
      const clampedX = Math.min(Math.max(srcX, 0), width - 1);
      const clampedY = Math.min(Math.max(srcY, 0), height - 1);
      const srcIdx = (clampedY * width + clampedX) * 4;
      const destIdx = (y * width + x) * 4;
      data[destIdx] = original[srcIdx];
      data[destIdx + 1] = original[srcIdx + 1];
      data[destIdx + 2] = original[srcIdx + 2];
      data[destIdx + 3] = original[srcIdx + 3];
    }
  }
}

// Ripple (water circles) effect
function applyRippleEffect(data, width, height, time) {
  const cx = width / 2;
  const cy = height / 2;
  const original = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy) || 1; // avoid zero
      const offset = 10 * Math.sin(r * 0.2 - time);
      const srcX = Math.round(x + offset * (dx / r));
      const srcY = Math.round(y + offset * (dy / r));
      const clampedX = Math.min(Math.max(srcX, 0), width - 1);
      const clampedY = Math.min(Math.max(srcY, 0), height - 1);
      const srcIdx = (clampedY * width + clampedX) * 4;
      const destIdx = (y * width + x) * 4;
      data[destIdx] = original[srcIdx];
      data[destIdx + 1] = original[srcIdx + 1];
      data[destIdx + 2] = original[srcIdx + 2];
      data[destIdx + 3] = original[srcIdx + 3];
    }
  }
}