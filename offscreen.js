(function () {
	let ws = null;
	let wsReady = false;
	let pendingBinaryQueue = [];
	let audioContext = null;
	let sourceNode = null;
	let workletNode = null;
	let gainNode = null;
	let inputStream = null;
	let allowProcessorFallback = true;
	let actualRate = 48000;
	let targetSampleRate = 16000;
	let frameSamples = Math.round((targetSampleRate * 20) / 1000);
	let bufferQueue = new Float32Array(0);

	function logErr(prefix, e) {
		try {
			console.error(prefix, {
				name: e && e.name,
				message: e && e.message,
				code: e && e.code,
				stack: e && e.stack
			});
		} catch {
			console.error(prefix, e);
		}
	}

	const WORKLET_INLINE_CODE = [
		'class MonoCaptureProcessor extends AudioWorkletProcessor {',
		'  constructor(){ super(); }',
		'  process(inputs){',
		'    const input = inputs && inputs[0];',
		'    if (!input || input.length === 0) return true;',
		'    const channels = input.length;',
		'    const len = input[0]?.length || 0;',
		'    if (len === 0) return true;',
		'    const mono = new Float32Array(len);',
		'    for (let ch = 0; ch < channels; ch++){',
		'      const chData = input[ch];',
		'      for (let i = 0; i < len; i++){ mono[i] += chData[i]; }',
		'    }',
		'    if (channels > 1){ for (let i = 0; i < len; i++) mono[i] /= channels; }',
		'    this.port.postMessage(mono.buffer, [mono.buffer]);',
		'    return true;',
		'  }',
		'}',
		'registerProcessor("mono-capture", MonoCaptureProcessor);'
	].join('\n');

	function floatTo16BitPCM(float32) {
		const len = float32.length;
		const out = new Int16Array(len);
		for (let i = 0; i < len; i++) {
			let s = float32[i];
			if (s > 1) s = 1;
			else if (s < -1) s = -1;
			out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
		}
		return out.buffer;
	}
	function resampleFloat32(buffer, sourceRate, targetRate) {
		if (sourceRate === targetRate) return buffer;
		const ratio = sourceRate / targetRate;
		const newLength = Math.round(buffer.length / ratio);
		const result = new Float32Array(newLength);
		let offsetResult = 0;
		let offsetBuffer = 0;
		while (offsetResult < newLength) {
			const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
			let accum = 0;
			let count = 0;
			for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
				accum += buffer[i];
				count++;
			}
			result[offsetResult] = count > 0 ? accum / count : 0;
			offsetResult++;
			offsetBuffer = nextOffsetBuffer;
		}
		return result;
	}
	function openWebSocket(url) {
		try {
			ws = new WebSocket(url);
		} catch (e) {
			console.error('[offscreen] WS init error:', e);
			return;
		}
		ws.binaryType = 'arraybuffer';
		ws.onopen = () => {
			wsReady = true;
			for (const buf of pendingBinaryQueue) ws.send(buf);
			pendingBinaryQueue = [];
		};
		ws.onerror = (err) => console.error('[offscreen] WS error', err);
		ws.onclose = () => { wsReady = false; };
	}
	function sendPCM(buffer) {
		if (!ws) return;
		if (wsReady) ws.send(buffer);
		else pendingBinaryQueue.push(buffer);
	}

	async function setupWithWorklet() {
		try {
			if (!audioContext.audioWorklet) throw new Error('AudioWorklet not supported');
			let loaded = false;
			try {
				const blob = new Blob([WORKLET_INLINE_CODE], { type: 'application/javascript' });
				const blobUrl = URL.createObjectURL(blob);
				try {
					await audioContext.audioWorklet.addModule(blobUrl);
					loaded = true;
				} finally {
					URL.revokeObjectURL(blobUrl);
				}
			} catch (_e) {
				loaded = false;
			}
			if (!loaded) {
				const moduleUrl = chrome.runtime.getURL('audio-worklet-processor.js');
				try {
					await audioContext.audioWorklet.addModule(moduleUrl);
					loaded = true;
				} catch (e1) {
					try {
						const res = await fetch(moduleUrl, { cache: 'no-store' });
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						const code = await res.text();
						const blob = new Blob([code], { type: 'application/javascript' });
						const blobUrl = URL.createObjectURL(blob);
						try {
							await audioContext.audioWorklet.addModule(blobUrl);
							loaded = true;
						} finally {
							URL.revokeObjectURL(blobUrl);
						}
					} catch (e2) {
						console.error('[offscreen] Worklet load failed', e1, e2);
						loaded = false;
					}
				}
			}
			if (!loaded) throw new Error('Worklet module load failed');
			workletNode = new AudioWorkletNode(audioContext, 'mono-capture');
			workletNode.port.onmessage = (ev) => {
				try {
					const ab = ev.data;
					const block = ab instanceof ArrayBuffer ? new Float32Array(ab) : new Float32Array(0);
					if (block.length === 0) return;
					const resampled = resampleFloat32(block, actualRate, targetSampleRate);
					if (bufferQueue.length === 0) bufferQueue = resampled;
					else {
						const merged = new Float32Array(bufferQueue.length + resampled.length);
						merged.set(bufferQueue, 0);
						merged.set(resampled, bufferQueue.length);
						bufferQueue = merged;
					}
					let offset = 0;
					while (bufferQueue.length - offset >= frameSamples) {
						const frame = bufferQueue.subarray(offset, offset + frameSamples);
						sendPCM(floatTo16BitPCM(frame));
						offset += frameSamples;
					}
					if (offset > 0) bufferQueue = bufferQueue.slice(offset);
				} catch (_e) {}
			};
			sourceNode.connect(workletNode);
			workletNode.connect(gainNode);
			gainNode.connect(audioContext.destination);
			return true;
		} catch (_e) {
			return false;
		}
	}

	async function startCapture(payload) {
		try {
			targetSampleRate = Number(payload?.sampleRate) || 16000;
			frameSamples = Math.round((targetSampleRate * 20) / 1000);
			allowProcessorFallback =
				typeof payload?.allowProcessorFallback === 'boolean'
					? payload.allowProcessorFallback
					: true;
			const tabId = payload?.tabId;
			const streamId = payload?.streamId; // fallback path if needed
			const wsUrl = payload?.wsUrl;
			if (!streamId || !wsUrl) throw new Error('Missing streamId/wsUrl');

			// Preferred: capture via chrome.tabCapture.capture in offscreen
			let captureErr = null;
			try {
				await new Promise((resolve) => setTimeout(resolve, 0)); // yield
				chrome.tabCapture.capture(
					{
						audio: true,
						video: false,
						// @ts-ignore: targetTabId is available in recent Chrome
						targetTabId: typeof tabId === 'number' ? tabId : undefined,
						audioConstraints: {
							mandatory: {
								echoCancellation: false,
								noiseSuppression: false,
								googAutoGainControl: false
							}
						}
					},
					(stream) => {
						if (chrome.runtime.lastError) {
							captureErr = new Error(chrome.runtime.lastError.message || 'tabCapture error');
							inputStream = null;
						} else {
							inputStream = stream || null;
						}
					}
				);
				// Wait a tick for callback
				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch (e) {
				captureErr = e;
			}
			if (!inputStream) {
				logErr('[offscreen] tabCapture.capture failed', captureErr);
				// Fallback: legacy streamId + gUM (may fail in offscreen)
				try {
					const constraints = {
						audio: {
							mandatory: {
								chromeMediaSource: 'tab',
								chromeMediaSourceId: streamId
							}
						},
						video: false
					};
					inputStream = await navigator.mediaDevices.getUserMedia(constraints);
				} catch (e2) {
					logErr('[offscreen] getUserMedia with streamId failed', e2);
					throw e2;
				}
			}

			try {
				audioContext = new (window.AudioContext || window.webkitAudioContext)({
					sampleRate: targetSampleRate
				});
			} catch (e) {
				logErr('[offscreen] AudioContext init failed', e);
				audioContext = new (window.AudioContext || window.webkitAudioContext)();
			}
			actualRate = audioContext.sampleRate;
			console.log('[offscreen] AudioContext created', { actualRate, targetSampleRate });
			sourceNode = audioContext.createMediaStreamSource(inputStream);
			gainNode = audioContext.createGain();
			gainNode.gain.value = 0;

			const okWorklet = await setupWithWorklet();
			if (!okWorklet) {
				if (!allowProcessorFallback) {
					console.error('[offscreen] AudioWorklet unsupported; fallback disabled.');
					try { audioContext.close(); } catch (_e) {}
					return;
				}
				const processorNode = audioContext.createScriptProcessor(4096, 2, 1);
				processorNode.onaudioprocess = (event) => {
					const mono = (() => {
						const numChannels = event.inputBuffer.numberOfChannels || 1;
						if (numChannels === 1) return event.inputBuffer.getChannelData(0).slice(0);
						const length = event.inputBuffer.length;
						const tmp = new Float32Array(length);
						for (let ch = 0; ch < numChannels; ch++) {
							const chData = event.inputBuffer.getChannelData(ch);
							for (let i = 0; i < length; i++) tmp[i] += chData[i];
						}
						for (let i = 0; i < length; i++) tmp[i] /= numChannels;
						return tmp;
					})();
					const resampled = resampleFloat32(mono, actualRate, targetSampleRate);
					if (bufferQueue.length === 0) bufferQueue = resampled;
					else {
						const merged = new Float32Array(bufferQueue.length + resampled.length);
						merged.set(bufferQueue, 0);
						merged.set(resampled, bufferQueue.length);
						bufferQueue = merged;
					}
					let offset = 0;
					while (bufferQueue.length - offset >= frameSamples) {
						const frame = bufferQueue.subarray(offset, offset + frameSamples);
						sendPCM(floatTo16BitPCM(frame));
						offset += frameSamples;
					}
					if (offset > 0) bufferQueue = bufferQueue.slice(offset);
				};
				sourceNode.connect(processorNode);
				processorNode.connect(gainNode);
				gainNode.connect(audioContext.destination);
			}

			openWebSocket(wsUrl);
			console.log('[offscreen] capture started', { targetSampleRate, actualRate });
		} catch (e) {
			logErr('[offscreen] startCapture error', e);
		}
	}

	function stopCapture() {
		try {
			if (workletNode) {
				try { workletNode.port.onmessage = null; } catch (_e01) {}
				try { workletNode.disconnect(); } catch (_e02) {}
			}
			if (sourceNode) { try { sourceNode.disconnect(); } catch (_e2) {} }
			if (gainNode) { try { gainNode.disconnect(); } catch (_e3) {} }
			if (inputStream) { try { inputStream.getTracks().forEach(t => t.stop()); } catch (_e4) {} }
			if (audioContext) { try { audioContext.close(); } catch (_e5) {} }
			if (ws) { try { ws.close(1000, 'stop'); } catch (_e6) {} }
		} finally {
			ws = null;
			wsReady = false;
			pendingBinaryQueue = [];
			audioContext = null;
			sourceNode = null;
			workletNode = null;
			gainNode = null;
			inputStream = null;
			bufferQueue = new Float32Array(0);
			console.log('[offscreen] capture stopped');
		}
	}

	chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
		if (msg?.type === 'OFFSCREEN_START') {
			startCapture(msg.payload);
			return true;
		}
		if (msg?.type === 'OFFSCREEN_STOP') {
			stopCapture();
			return true;
		}
		return undefined;
	});
})();


