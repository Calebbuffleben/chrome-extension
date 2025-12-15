// Popup UI para iniciar a captura

function setStatus(msg, cls) {
	const el = document.getElementById('status');
	el.textContent = msg || '';
	el.className = cls || '';
}

function isMeetUrl(url) {
	try {
		const u = new URL(url);
		return u.hostname === 'meet.google.com';
	} catch (_e) {
		return false;
	}
}

document.addEventListener('DOMContentLoaded', () => {
	const startBtn = document.getElementById('startBtn');
	const stopBtn = document.getElementById('stopBtn');
	const sampleRateInput = document.getElementById('sampleRate');

	startBtn.addEventListener('click', () => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs && tabs[0];
			if (!tab || !tab.id) {
				setStatus('Nenhuma aba ativa encontrada.', 'err');
				return;
			}
			if (!isMeetUrl(tab.url || '')) {
				setStatus('Abra uma reunião do Google Meet e tente novamente.', 'err');
				return;
			}

			const sampleRate = parseInt(sampleRateInput.value, 10) || 16000;

			chrome.runtime.sendMessage(
				{
					type: 'START_CAPTURE',
					tabId: tab.id,
					sampleRate
				},
				(resp) => {
					if (chrome.runtime.lastError) {
						setStatus(`Erro: ${chrome.runtime.lastError.message}`, 'err');
						return;
					}
					if (resp && resp.ok) {
						setStatus('Captura iniciada.', 'ok');
					} else {
						setStatus(`Falha: ${resp && resp.error ? resp.error : 'desconhecida'}`, 'err');
					}
				}
			);
		});
	});

	stopBtn.addEventListener('click', () => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const tab = tabs && tabs[0];
			if (!tab || !tab.id) {
				setStatus('Nenhuma aba ativa encontrada.', 'err');
				return;
			}
			if (!isMeetUrl(tab.url || '')) {
				setStatus('Esta aba não é uma reunião do Google Meet.', 'err');
				return;
			}
			chrome.runtime.sendMessage(
				{
					type: 'STOP_CAPTURE',
					tabId: tab.id
				},
				(resp) => {
					if (chrome.runtime.lastError) {
						setStatus(`Erro: ${chrome.runtime.lastError.message}`, 'err');
						return;
					}
					if (resp && resp.ok) {
						setStatus('Captura parada.', 'ok');
					} else {
						setStatus(`Falha ao parar: ${resp && resp.error ? resp.error : 'desconhecida'}`, 'err');
					}
				}
			);
		});
	});
});


