// =================================================================================
//
//  efgh over WebSocket on Cloudflare Workers
//
//  Version: The Absolute 복제 (Replication)
//  This version is a surgical transplant of the working HTTP routing onto the
//  user's original, proven, and UNTOUCHED core proxy logic.
//  No refactoring, no "improvements". Only replication of what works.
//
// =================================================================================

// @ts-ignore
import { connect } from 'cloudflare:sockets';

// --- 1. Configuration Area ---
let userID = 'a00c15f5-7cb2-4790-81f2-9a174081f5dc';
let proxyIP = '38.22.233.228'; // Your proxy IP, if needed.
let dohURL = 'https://1.1.1.1/dns-query';

// --- 2. Main Logic ---
if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	/**
	 * This fetch function is the "shell" that wraps the original core logic.
	 */
	async fetch(request, env, ctx) {
		// Load config from environment variables, falling back to hardcoded values.
		userID = env.UUID || userID;
		proxyIP = env.PROXYIP || proxyIP;
		dohURL = env.DOH_URL || dohURL;

		const upgradeHeader = request.headers.get('Upgrade');
		if (upgradeHeader === 'websocket') {
			// Pass the request to the original, untouched handler.
			return efghOverWSHandler(request);
		}

		const url = new URL(request.url);
		switch (url.pathname) {
			case '/':
				const decoyString = '8kZp$qE9!w#rT1yU&iO2p@sD*fG4hJ6kL8zXcV0bN2m';
				return new Response(decoyString, { status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" } });

			case `/${userID}`:
				const efghConfig = getefghConfig(userID, request.headers.get('Host'));
				return new Response(efghConfig, { status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" } });

			default:
				return new Response('Not Found', { status: 404 });
		}
	},
};


// =================================================================================
//
//  --- UNTOUCHED CORE PROXY LOGIC ---
//  The following code from this point onwards is a 1:1 copy of the user's
//  original, working script, with only minimal changes for configurable DoH
//  and silent logging. The core TCP handling is IDENTICAL.
//
// =================================================================================

async function efghOverWSHandler(request) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		// console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	let remoteSocketWapper = { value: null };
	let udpStreamWrite = null;
	let isDns = false;

	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) { return udpStreamWrite(chunk); }
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter();
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const { hasError, message, portRemote = 443, addressRemote = '', rawDataIndex, efghVersion = new Uint8Array([0, 0]), isUDP } = processefghHeader(chunk, userID);
			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '} `;
			if (hasError) { throw new Error(message); }
			
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					throw new Error('UDP proxy only enable for DNS which is port 53');
				}
			}
			const efghResponseHeader = new Uint8Array([efghVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, efghResponseHeader, log, dohURL);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, efghResponseHeader, log);
		},
		close() { log(`readableWebSocketStream is close`); },
		abort(reason) { log(`readableWebSocketStream is abort`, JSON.stringify(reason)); },
	})).catch((err) => { /* console.error(err); */ });

	return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, efghResponseHeader, log,) {
	async function connectAndWrite(address, port) {
		const tcpSocket = await connect({ hostname: address, port: port });
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}

	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		});
		remoteSocketToWS(tcpSocket, webSocket, efghResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);
	remoteSocketToWS(tcpSocket, webSocket, efghResponseHeader, retry, log);
}

async function remoteSocketToWS(remoteSocket, webSocket, efghResponseHeader, retry, log) {
	let hasIncomingData = false;
	await remoteSocket.readable.pipeTo(new WritableStream({
		async write(chunk, controller) {
			hasIncomingData = true;
			if (webSocket.readyState !== 1) { // WS_READY_STATE_OPEN
				controller.error('webSocket.readyState is not open, maybe close');
			}
			if (efghResponseHeader) {
				webSocket.send(await new Blob([efghResponseHeader, chunk]).arrayBuffer());
				efghResponseHeader = null;
			} else {
				webSocket.send(chunk);
			}
		},
		close() { log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`); },
		abort(reason) { console.error(`remoteConnection!.readable abort`, reason); },
	})).catch((error) => {
		console.error(`remoteSocketToWS has exception `, error.stack || error);
		safeCloseWebSocket(webSocket);
	});

	if (hasIncomingData === false && retry) {
		log(`retry`);
		retry();
	}
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) return;
				controller.enqueue(event.data);
			});
			webSocketServer.addEventListener('close', () => {
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) return;
				controller.close();
			});
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			});
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) { controller.error(error); } else if (earlyData) { controller.enqueue(earlyData); }
		},
		cancel(reason) {
			if (readableStreamCancel) return;
			log(`ReadableStream was canceled, due to ${reason}`);
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});
	return stream;
}

async function handleUDPOutBound(webSocket, efghResponseHeader, log, dohURL) {
	let isefghHeaderSent = false;
	const transformStream = new TransformStream({
		transform(chunk, controller) {
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
	});
	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch(dohURL, { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk });
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === 1) { // WS_READY_STATE_OPEN
				log(`doh success and dns message length is ${udpSize}`);
				if (isefghHeaderSent) {
					webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
				} else {
					webSocket.send(await new Blob([efghResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
					isefghHeaderSent = true;
				}
			}
		}
	})).catch((error) => { log('dns udp has error' + error); });
	const writer = transformStream.writable.getWriter();
	return { write(chunk) { writer.write(chunk); } };
}

function processefghHeader(efghBuffer, userID) {
	if (efghBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
	const version = new Uint8Array(efghBuffer.slice(0, 1));
	if (stringify(new Uint8Array(efghBuffer.slice(1, 17))) !== userID) return { hasError: true, message: 'invalid user' };
	const optLength = new Uint8Array(efghBuffer.slice(17, 18))[0];
	const command = new Uint8Array(efghBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
	let isUDP = false;
	if (command === 1) {} else if (command === 2) isUDP = true; else return { hasError: true, message: `command ${command} is not support, command 01-tcp,02-udp,03-mux` };
	const portIndex = 18 + optLength + 1;
	const portRemote = new DataView(efghBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
	let addressIndex = portIndex + 2;
	const addressType = new Uint8Array(efghBuffer.slice(addressIndex, addressIndex + 1))[0];
	let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(efghBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(efghBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(efghBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(efghBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
			const ipv6 = [];
			for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
			addressValue = ipv6.join(':');
			break;
		default: return { hasError: true, message: `invild  addressType is ${addressType}` };
	}
	if (!addressValue) return { hasError: true, message: `addressValue is empty, addressType is ${addressType}` };
	return { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, efghVersion: version, isUDP };
}

function base64ToArrayBuffer(base64Str) {
	if (!base64Str) return { error: null };
	try {
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) { return { error }; }
}

function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === 1 || socket.readyState === 2) { // 1: OPEN, 2: CLOSING
			socket.close();
		}
	} catch (error) { console.error('safeCloseWebSocket error', error); }
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) byteToHex.push((i + 256).toString(16).slice(1));
function stringify(arr, offset = 0) {
	const unsafeStringify = (arr, offset = 0) => (byteToHex[arr[offset+0]]+byteToHex[arr[offset+1]]+byteToHex[arr[offset+2]]+byteToHex[arr[offset+3]]+"-"+byteToHex[arr[offset+4]]+byteToHex[arr[offset+5]]+"-"+byteToHex[arr[offset+6]]+byteToHex[arr[offset+7]]+"-"+byteToHex[arr[offset+8]]+byteToHex[arr[offset+9]]+"-"+byteToHex[arr[offset+10]]+byteToHex[arr[offset+11]]+byteToHex[arr[offset+12]]+byteToHex[arr[offset+13]]+byteToHex[arr[offset+14]]+byteToHex[arr[offset+15]]).toLowerCase();
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) throw TypeError("Stringified UUID is invalid");
	return uuid;
}

function getefghConfig(userID, hostName) {
	return `efgh://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
}
