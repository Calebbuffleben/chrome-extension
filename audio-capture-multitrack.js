// Multi-Track Audio Capture for Google Meet
// Captures and processes multiple participant audio streams simultaneously
// Each remote WebRTC track is processed independently

(function () {
	console.log('[audio-capture-mt] Initializing multi-track audio capture');

	const DEFAULT_SAMPLE_RATE = 16000;
	const FRAME_MS = 20;

	// Global state
	let _tabId = null;
	let _meetingId = null;
	let _wsBaseUrl = null;

	// Participant audio processors: participantId -> ProcessorState
	const audioProcessors = new Map();

	// Inline worklet code with detailed debugging
	const WORKLET_INLINE_CODE = [
		'class MonoCaptureProcessor extends AudioWorkletProcessor {',
		'  constructor(){ super(); this._processCount = 0; this._lastLog = 0; this._nonZeroCount = 0; }',
		'  process(inputs){',
		'    this._processCount++;',
		'    const input = inputs && inputs[0];',
		'    if (!input || input.length === 0) {',
		'      if (this._processCount % 100 === 0) {',
		'        this.port.postMessage({ type: "debug", msg: "No input", count: this._processCount });',
		'      }',
		'      return true;',
		'    }',
		'    const channels = input.length;',
		'    const len = input[0]?.length || 0;',
		'    if (len === 0) {',
		'      if (this._processCount % 100 === 0) {',
		'        this.port.postMessage({ type: "debug", msg: "Zero length", count: this._processCount });',
		'      }',
		'      return true;',
		'    }',
		'    const mono = new Float32Array(len);',
		'    let hasNonZero = false;',
		'    let maxAbs = 0;',
		'    for (let ch = 0; ch < channels; ch++){',
		'      const chData = input[ch];',
		'      for (let i = 0; i < len; i++){',
		'        mono[i] += chData[i];',
		'        const abs = Math.abs(chData[i]);',
		'        if (abs > 0.00001) hasNonZero = true;',
		'        if (abs > maxAbs) maxAbs = abs;',
		'      }',
		'    }',
		'    if (channels > 1){ for (let i = 0; i < len; i++) mono[i] /= channels; }',
		'    if (hasNonZero) this._nonZeroCount++;',
		'    const now = Date.now();',
		'    if (now - this._lastLog > 2000) {',
		'      this.port.postMessage({ type: "stats", hasAudio: hasNonZero, maxAbs, processCount: this._processCount, nonZeroCount: this._nonZeroCount, channels, len });',
		'      this._lastLog = now;',
		'    }',
		'    this.port.postMessage({ type: "audio", buffer: mono.buffer }, [mono.buffer]);',
		'    return true;',
		'  }',
		'}',
		'registerProcessor("mono-capture", MonoCaptureProcessor);',
	].join('\n');

	// Processor state for one participant
	class ParticipantAudioProcessor {
		constructor(participantId, participantName, track, targetSampleRate) {
			this.participantId = participantId;
			this.participantName = participantName || participantId;
			this.track = track;
			this.targetSampleRate = targetSampleRate;
			
			this.audioContext = null;
			this.sourceNode = null;
			this.workletNode = null;
			this.gainNode = null;
			this.stream = null;
			this.bufferQueue = new Float32Array(0);
			this.bytesSent = 0;
			this.isRunning = false;
			this.workletLoaded = false;

			console.log(`[audio-capture-mt] Created processor for ${this.participantId} (${this.participantName})`);
		}

		async start() {
			if (this.isRunning) {
				console.warn(`[audio-capture-mt] Processor already running for ${this.participantId}`);
				return;
			}

			try {
				console.log(`[audio-capture-mt] Starting processor for ${this.participantId}`);

				// Create stream from track
				this.stream = new MediaStream([this.track]);

				// Create AudioContext
				try {
					this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
						sampleRate: this.targetSampleRate,
					});
				} catch (_e) {
					this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
				}

				const actualRate = this.audioContext.sampleRate;
				const frameSamples = Math.round((this.targetSampleRate * FRAME_MS) / 1000);

				console.log(`[audio-capture-mt] ${this.participantId}: AudioContext created`, {
					targetRate: this.targetSampleRate,
					actualRate,
					state: this.audioContext.state,
				});

				// Resume context if suspended
				if (this.audioContext.state === 'suspended') {
					await this.audioContext.resume();
				}

				// Create source from stream
				this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
				this.gainNode = this.audioContext.createGain();
				this.gainNode.gain.value = 0; // Silent output (no echo)

				// Setup AudioWorklet
				await this.setupWorklet(actualRate, frameSamples);

				// Open WebSocket for this participant
				this.openWebSocket();

				this.isRunning = true;
				console.log(`[audio-capture-mt] ✅ ${this.participantId} processor started`);
			} catch (e) {
				console.error(`[audio-capture-mt] Failed to start processor for ${this.participantId}:`, e);
				this.stop();
			}
		}

		async setupWorklet(actualRate, frameSamples) {
			try {
				// Load worklet module
				if (!this.workletLoaded) {
					const blob = new Blob([WORKLET_INLINE_CODE], { type: 'application/javascript' });
					const blobUrl = URL.createObjectURL(blob);
					try {
						await this.audioContext.audioWorklet.addModule(blobUrl);
						this.workletLoaded = true;
					} finally {
						URL.revokeObjectURL(blobUrl);
					}
				}

				// Create worklet node
				this.workletNode = new AudioWorkletNode(this.audioContext, 'mono-capture');

			// Handle messages from worklet
			this.workletNode.port.onmessage = (ev) => {
				try {
					const data = ev.data;
					
					// Handle debug messages
					if (data && typeof data === 'object' && data.type === 'debug') {
						console.log(`[audio-capture-mt] ${this.participantId} WORKLET DEBUG:`, data.msg, `count=${data.count}`);
						return;
					}
					
					// Handle stats messages
					if (data && typeof data === 'object' && data.type === 'stats') {
						console.log(`[audio-capture-mt] ${this.participantId} AUDIO STATS:`, {
							hasAudio: data.hasAudio,
							maxAbs: data.maxAbs?.toFixed(6),
							processCount: data.processCount,
							nonZeroCount: data.nonZeroCount,
							channels: data.channels,
							samplesPerBlock: data.len
						});
						return;
					}
					
					// Handle audio data
					const ab = (data && data.type === 'audio') ? data.buffer : data;
					const block = ab instanceof ArrayBuffer ? new Float32Array(ab) : new Float32Array(0);
					if (block.length === 0) return;

					// Resample if needed
					const resampled = this.resampleFloat32(block, actualRate, this.targetSampleRate);

					// Queue
					if (this.bufferQueue.length === 0) {
						this.bufferQueue = resampled;
					} else {
						const merged = new Float32Array(this.bufferQueue.length + resampled.length);
						merged.set(this.bufferQueue, 0);
						merged.set(resampled, this.bufferQueue.length);
						this.bufferQueue = merged;
					}

					// Send frames
					let offset = 0;
					while (this.bufferQueue.length - offset >= frameSamples) {
						const frame = this.bufferQueue.subarray(offset, offset + frameSamples);
						const pcm = this.floatTo16BitPCM(frame);
						this.sendPCM(pcm);
						offset += frameSamples;
						this.bytesSent += pcm.byteLength || 0;
					}

					// Keep remainder
					if (offset > 0) {
						this.bufferQueue = this.bufferQueue.slice(offset);
					}
				} catch (_e) {}
			};

				// Connect audio graph
				this.sourceNode.connect(this.workletNode);
				this.workletNode.connect(this.gainNode);
				this.gainNode.connect(this.audioContext.destination);

				console.log(`[audio-capture-mt] ${this.participantId}: Worklet setup complete`);
			} catch (e) {
				console.error(`[audio-capture-mt] ${this.participantId}: Worklet setup failed:`, e);
				throw e;
			}
		}

	floatTo16BitPCM(float32) {
		const len = float32.length;
		const out = new Int16Array(len);
		
		// Find peak amplitude for normalization
		let peak = 0;
		for (let i = 0; i < len; i++) {
			const abs = Math.abs(float32[i]);
			if (abs > peak) peak = abs;
		}
		
		// Apply aggressive auto-gain for quiet signals
		// Target: normalize quiet signals to 0.7 (higher than before)
		let gain = 1.0;
		if (peak > 0.00001 && peak < 0.3) {
			// Amplify by up to 50x for very quiet signals
			// This will bring even -60 dBFS signals up to usable levels
			gain = Math.min(50.0, 0.7 / peak);
			if (!this._lastGainLog || Date.now() - this._lastGainLog > 5000) {
				console.log(`[audio-capture-mt] ${this.participantId} AUTO-GAIN: ${gain.toFixed(2)}x (peak was ${peak.toFixed(6)})`);
				this._lastGainLog = Date.now();
			}
		}
		
		// Convert to 16-bit PCM with gain applied
		for (let i = 0; i < len; i++) {
			let s = float32[i] * gain;
			if (s > 1) s = 1;
			else if (s < -1) s = -1;
			out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
		}
		return out.buffer;
	}

		resampleFloat32(buffer, sourceRate, targetRate) {
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

		openWebSocket() {
			if (!_wsBaseUrl || !_meetingId) {
				console.error(`[audio-capture-mt] Missing wsBaseUrl or meetingId`);
				return;
			}

			// Build URL with participant info
			// Parse base URL and add parameters correctly
			const baseUrl = new URL(_wsBaseUrl);
			baseUrl.searchParams.set('room', _meetingId);
			baseUrl.searchParams.set('meetingId', _meetingId);
			baseUrl.searchParams.set('participant', this.participantId);
			baseUrl.searchParams.set('source', 'browser');
			baseUrl.searchParams.set('track', 'webrtc-audio');
			baseUrl.searchParams.set('sampleRate', String(this.targetSampleRate));
			baseUrl.searchParams.set('channels', '1');
			
			const url = baseUrl.toString();
			console.log(`[audio-capture-mt] ${this.participantId}: Opening WebSocket:`, url);

			window.postMessage(
				{
					type: 'AUDIO_WS_OPEN',
					url,
					tabId: _tabId,
					participantId: this.participantId,
				},
				'*',
			);
		}

		sendPCM(buffer) {
			const ab = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
			
			if (this.bytesSent % 64000 < 1280) {
				console.log(`[audio-capture-mt] ${this.participantId}: sendPCM`, {
					byteLength: ab.byteLength,
					bytesSent: this.bytesSent,
				});
			}

			window.postMessage(
				{
					type: 'AUDIO_WS_SEND',
					buffer: ab,
					tabId: _tabId,
					participantId: this.participantId,
				},
				'*',
			);
		}

		stop() {
			console.log(`[audio-capture-mt] Stopping processor for ${this.participantId}`);

			try {
				if (this.workletNode) {
					this.workletNode.port.onmessage = null;
					this.workletNode.disconnect();
				}
				if (this.sourceNode) this.sourceNode.disconnect();
				if (this.gainNode) this.gainNode.disconnect();
				if (this.audioContext) this.audioContext.close();

				// Close WebSocket
				window.postMessage(
					{
						type: 'AUDIO_WS_CLOSE',
						tabId: _tabId,
						participantId: this.participantId,
					},
					'*',
				);
			} catch (e) {
				console.error(`[audio-capture-mt] Error stopping ${this.participantId}:`, e);
			} finally {
				this.isRunning = false;
				this.audioContext = null;
				this.sourceNode = null;
				this.workletNode = null;
				this.gainNode = null;
				this.stream = null;
			}
		}
	}

	// Handle track participant mapping
	window.addEventListener('message', (event) => {
		if (event.source !== window) return;
		const data = event.data || {};

		// When a track is mapped to a participant, start processing
		if (data.type === 'TRACK_PARTICIPANT_MAPPED') {
			const { trackId, participantId, participantName } = data;
			console.log(`[audio-capture-mt] Track mapped:`, { trackId, participantId, participantName });

			// Get the track from webrtc-interceptor registry
			if (window.__webrtcInterceptor) {
				const trackInfo = window.__webrtcInterceptor.tracksRegistry.get(trackId);
				if (trackInfo && trackInfo.track) {
					handleRemoteTrack(participantId, participantName, trackInfo.track);
				} else {
					console.error(`[audio-capture-mt] Track ${trackId} not found in registry`);
				}
			}
		}

		// Handle track removal
		if (data.type === 'WEBRTC_TRACK_REMOVED') {
			const { trackId } = data;
			
			// Find which participant this track belongs to
			for (const [participantId, processor] of audioProcessors.entries()) {
				if (processor.track.id === trackId) {
					console.log(`[audio-capture-mt] Removing processor for ${participantId}`);
					processor.stop();
					audioProcessors.delete(participantId);
					break;
				}
			}
		}

		// Initial setup command
		if (data.type === 'AUDIO_CAPTURE_START_MULTITRACK') {
			const payload = data.payload || {};
			const { tabId, meetingId, wsUrl, sampleRate } = payload;
			console.log('[audio-capture-mt] Starting multi-track capture', { tabId, meetingId, wsUrl });

			_tabId = tabId;
			_meetingId = meetingId;
			_wsBaseUrl = wsUrl;

			console.log('[audio-capture-mt] ✅ Ready to capture tracks');
			
			// IMPORTANT: Check for tracks that were already captured before we initialized
			// This handles the case where interceptor captured tracks before multi-track system started
			if (window.__webrtcInterceptor && window.__webrtcInterceptor.tracksRegistry) {
				const existingTracks = window.__webrtcInterceptor.tracksRegistry;
				console.log(`[audio-capture-mt] Found ${existingTracks.size} existing tracks, processing retroactively`);
				
				for (const [trackId, trackInfo] of existingTracks.entries()) {
					if (trackInfo.track.kind === 'audio') {
						console.log(`[audio-capture-mt] Processing existing audio track: ${trackId}`);
						// Trigger track assignment
						window.postMessage({
							type: 'WEBRTC_TRACK_ADDED',
							trackId: trackInfo.trackId,
							trackLabel: trackInfo.track.label,
							streamId: trackInfo.stream?.id,
							pcId: trackInfo.pcId,
							timestamp: trackInfo.capturedAt || Date.now(),
						}, '*');
					}
				}
			}
		}

		// Stop all
		if (data.type === 'AUDIO_CAPTURE_STOP_MULTITRACK') {
			console.log('[audio-capture-mt] Stopping all processors');
			for (const processor of audioProcessors.values()) {
				processor.stop();
			}
			audioProcessors.clear();
		}
	});

	async function handleRemoteTrack(participantId, participantName, track) {
		console.log(`[audio-capture-mt] Handling remote track for ${participantId}`);

		// Check if already processing this participant
		if (audioProcessors.has(participantId)) {
			console.warn(`[audio-capture-mt] Already processing ${participantId}, skipping`);
			return;
		}

		// Create processor
		const processor = new ParticipantAudioProcessor(
			participantId,
			participantName,
			track,
			DEFAULT_SAMPLE_RATE,
		);

		audioProcessors.set(participantId, processor);

		// Start processing
		await processor.start();
	}

	// Expose for debugging
	window.__audioCaptureMultiTrack = {
		audioProcessors,
		getActiveProcessors: () => Array.from(audioProcessors.entries()).map(([id, p]) => ({
			participantId: id,
			participantName: p.participantName,
			isRunning: p.isRunning,
			bytesSent: p.bytesSent,
		})),
	};

	console.log('[audio-capture-mt] ✅ Multi-track audio capture ready');
})();

