import { exists } from "https://deno.land/std/fs/exists.ts";

// ... (UUID management and utility functions remain largely the same)
//      isValidUUID, getUUIDFromConfig, saveUUIDToConfig,
//      processVlessHeader, stringify, unsafeStringify, etc.

const envUUID = Deno.env.get('UUID') || 'e5185305-1984-4084-81e0-f77271159c62';
const proxyIP = Deno.env.get('PROXYIP') || '';
const credit = Deno.env.get('CREDIT') || 'DenoBy-ModsBots';

const CONFIG_FILE = 'config.json';

interface Config {
  uuid?: string;
}

// ... (getUUIDFromConfig and saveUUIDToConfig - unchanged)

// Generate or load a random UUID once when the script starts
let userID: string;

// ... (UUID loading logic - unchanged)

if (!isValidUUID(userID)) {
  throw new Error('uuid is not valid');
}

console.log(Deno.version);
console.log(`Final UUID in use: ${userID}`);

// New TCP server listens on a specific port (e.g., 443 for TLS, or 80 for plain)
// Note: You'll likely need to listen on 0.0.0.0 for external access
const TCP_PORT = 443; // Or 80 for plain TCP, or any other desired port

console.log(`Starting TCP VLESS proxy on port ${TCP_PORT}`);

// Deno.serve can handle TCP connections directly
Deno.serve({ port: TCP_PORT, hostname: "0.0.0.0" }, async (conn: Deno.TcpConn) => {
  console.log(`Incoming TCP connection from ${conn.remoteAddr.hostname}:${conn.remoteAddr.port}`);

  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();

  let receivedInitialData = false;
  let remoteSocketWapper: any = { value: null };
  let udpStreamWrite: any = null;
  let isDns = false;

  try {
    while (true) {
      const { value: chunk, done } = await reader.read();

      if (done) {
        console.log(`Client ${conn.remoteAddr.hostname} disconnected.`);
        break;
      }

      if (!chunk || chunk.byteLength === 0) {
        continue;
      }

      if (!receivedInitialData) {
        // Process VLESS header from the first chunk
        const {
          hasError,
          message,
          portRemote = 443,
          addressRemote = '',
          rawDataIndex,
          vlessVersion = new Uint8Array([0, 0]),
          isUDP,
        } = processVlessHeader(chunk.buffer, userID); // userID is global here

        if (hasError) {
          console.error(`VLESS header error for ${conn.remoteAddr.hostname}: ${message}`);
          await writer.write(new TextEncoder().encode("VLESS: Invalid request.\n")); // Send a simple error back
          conn.close();
          break;
        }

        console.log(`Parsed VLESS header: ${addressRemote}:${portRemote} (UDP: ${isUDP})`);

        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]); // VLESS response header

        if (isUDP) {
          if (portRemote === 53) {
            isDns = true;
            const { write } = await handleUDPOutBound(conn, vlessResponseHeader, (info) => console.log(info));
            udpStreamWrite = write;
            // Write remaining data after VLESS header to UDP handler
            udpStreamWrite(chunk.slice(rawDataIndex));
          } else {
            console.error(`UDP proxy only enabled for DNS (port 53). Requested port: ${portRemote}`);
            await writer.write(new TextEncoder().encode("VLESS: UDP proxy only for DNS (port 53).\n"));
            conn.close();
            break;
          }
        } else {
          // TCP: Connect to remote
          await handleTCPOutBound(
            remoteSocketWapper,
            addressRemote,
            portRemote,
            chunk.slice(rawDataIndex), // Raw client data after VLESS header
            conn, // Pass the client's TCP connection
            vlessResponseHeader,
            (info) => console.log(info)
          );
        }
        receivedInitialData = true;
      } else {
        // Subsequent chunks: just pipe them
        if (isDns && udpStreamWrite) {
          udpStreamWrite(chunk);
        } else if (remoteSocketWapper.value) {
          await remoteSocketWapper.value.writable.getWriter().write(chunk);
        } else {
          console.warn("Received data before remote socket established or for unsupported command.");
          // This case should ideally not happen if initial processing is correct
        }
      }
    }
  } catch (e) {
    console.error(`Error handling TCP connection from ${conn.remoteAddr.hostname}:`, e);
  } finally {
    try {
      reader.releaseLock();
      writer.releaseLock();
      conn.close();
      if (remoteSocketWapper.value) {
        remoteSocketWapper.value.close();
      }
    } catch (cleanupError) {
      console.error("Error during TCP connection cleanup:", cleanupError);
    }
  }
});

// --- MODIFIED handleTCPOutBound ---
// This function needs to send the remote socket's readable stream directly to the client's writable stream.
async function handleTCPOutBound(
  remoteSocket: { value: any },
  addressRemote: string,
  portRemote: number,
  rawClientData: Uint8Array,
  clientConn: Deno.TcpConn, // Changed from WebSocket to Deno.TcpConn
  vlessResponseHeader: Uint8Array,
  log: (info: string, event?: string) => void
) {
  async function connectAndWrite(address: string, port: number) {
    const tcpSocket = await Deno.connect({
      port: port,
      hostname: address,
    });
    remoteSocket.value = tcpSocket;
    log(`Connected to remote TCP ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(new Uint8Array(rawClientData));
    writer.releaseLock();
    return tcpSocket;
  }

  const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);

  // Pipe remote socket's readable stream to the client's writable stream
  // First, send the VLESS response header
  await clientConn.writable.getWriter().write(vlessResponseHeader);

  // Then, pipe the rest of the data
  tcpSocket.readable
    .pipeTo(clientConn.writable, { preventClose: true }) // preventClose so clientConn isn't closed prematurely
    .catch((error) => {
      log(`Error piping remote to client: ${error}`);
      clientConn.close();
    });

  // Client's writable is handled by the main loop reading from clientConn.readable
  // and writing to remoteSocket.value.writable
}

// --- MODIFIED handleUDPOutBound ---
// This function now writes directly to the client's Deno.TcpConn
async function handleUDPOutBound(
  clientConn: Deno.TcpConn, // Changed from WebSocket to Deno.TcpConn
  vlessResponseHeader: Uint8Array,
  log: (info: string) => void
) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    start(controller) {},
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    },
    flush(controller) {},
  });

  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const resp = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: {
              'content-type': 'application/dns-message',
            },
            body: chunk,
          });
          const dnsQueryResult = await resp.arrayBuffer();
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

          // Write directly to the client's TCP connection
          const writer = clientConn.writable.getWriter();
          try {
            if (!isVlessHeaderSent) {
              await writer.write(vlessResponseHeader);
              isVlessHeaderSent = true;
            }
            await writer.write(udpSizeBuffer);
            await writer.write(new Uint8Array(dnsQueryResult));
            log(`DOH success and DNS message length is ${udpSize}`);
          } catch (e) {
            log(`Error writing DNS result to client: ${e}`);
            clientConn.close(); // Close client if write fails
          } finally {
            writer.releaseLock();
          }
        },
        close() {
          log("UDP writable stream closed.");
        },
        abort(reason) {
          log(`UDP writable stream aborted: ${reason}`);
          clientConn.close();
        }
      })
    )
    .catch((error) => {
      log('DNS UDP handling has error: ' + error);
      clientConn.close(); // Ensure client connection is closed on error
    });

  const writer = transformStream.writable.getWriter();

  return {
    write(chunk: Uint8Array) {
      writer.write(chunk);
    },
  };
}


// ... (remove makeReadableWebSocketStream, base64ToArrayBuffer, safeCloseWebSocket, WS_READY_STATE_OPEN/CLOSING, stringify related to WS)
// Keep isValidUUID, stringify, unsafeStringify if still needed for UUID management
