import fs from 'node:fs/promises';
import dgram from 'node:dgram';
import { getLogger, LogContext } from '@balena/jellyfish-logger';
import { HandoverMessage } from './handover-message';
import { networkInterfaces } from 'os';
const logger = getLogger(__filename);

/**
 * A HandoverPeer provides a way to coordinate the handover between the new and old instances of services that are updated using the handover strategy described
 * at https://www.balena.io/docs/learn/deploy/release-strategy/update-strategies/#hand-over
 *
 * It implements a simple protool based on messages broadcasted over UDP. Each peer broadcast a message wich contains it startup timestamp. Whenever a server receives
 * a message with a higher timestamp than its own, it realizes that there's a younger instance running and shuts itself down in an orderly fashion.
 *
 * When a service starts, it first will create a `HandoverPeer` and calls its `startListening` method with a callback that will shut down the service.
 * When it's ready to accept connections, it will call the `startBroadcasting` method, thus starting to broadcast a packet that contains its
 * startup timestamp and letting other peers ( there should be one active in normal circumstances ) that they should shut down.
 *
 * Note that there is an overlap in which both services will be running concurrently, thus the application needs to handle this situation correctly. In Jellyfish,
 * each service runs a set of node Worker processes. When a new service starts, it will spawn another set of Workers that will run the initialization code.
 * There's a period of time during which the Workers from the old service will consume jobs from the queues that are inserted by the new service. Thus it is
 * critical to perform the shutdown in an orderly fashion to avoid losing data.
 *
 * Also note that the handover strategy will kill the old service after the configured `io.balena.update.handover-timeout` so it's important to configura that value
 * so that an orderly shutdown can be performed.
 *
 * Networking - On a fleet with several devices running on the same LAN:
 *
 * By default (HANDOVER_NETWORK_MODE=bridge) a multicast address is used; the service listens on all interfaces for updates.
 * In a docker bridge-mode network, the old and new instances will be the only ones using this address ( the bridge network is local to the device).
 *
 * If the container uses a host-mode network, and there
 * are several devices running the application in the same LAN, like in a fleet, then a multicast address would be be shared by all of the container instances and
 * this would cause only one to be selected
 * as the "new one", meaning that in one node both instances will shutdown and recreated, creating an infinite loop.
 * To avoid this, if using an application which has
 * host-mode network, you can specify the `HANDOVER_NETWORK_MODE=host` env var. This will cause the library to use the multicast address only on the
 * supervisor0 interface, which is a "local bridge" network.
 */

// Following https://www.rfc-editor.org/rfc/rfc2365.html, we use "The IPv4 Organization Local Scope -- 239.192.0.0/14" [ 239.192.0.0, 239.195.255.255 ]
// 239.192.0.0/14 is defined to be the IPv4 Organization Local Scope, and is the space from which an organization should allocate sub-ranges when defining scopes for private use.

const DEFAULT_SHUTDOWN_BROADCAST_ADDRESS = '239.192.16.16';

/**
 * The default network interface to try
 */
const NETWORK_INTERFACE = process.env.NETWORK_INTERFACE || 'supervisor0';

const HANDOVER_NETWORK_MODE = process.env.HANDOVER_NETWORK_MODE || 'bridge';

export class HandoverPeer {
	// semaphore, used to avoid starting new tasks if we're shutting down.
	shuttingDown: boolean = false;
	shutdownPort: number = parseInt(process.env.SHUTDOWN_PORT || '1536', 10);
	shutdownBroadcastAddress: string;
	ticker?: NodeJS.Timer;
	heartbeatSenderSocket: dgram.Socket;
	heartbeatClientSocket: dgram.Socket;
	startedAt: Date;
	handoverMessage: HandoverMessage;
	context: LogContext = {
		id: `PID${process.pid}-${'[' + Math.round(Math.random() * 1000) + ']'}-`,
	};

	constructor(startedAt: Date, context?: LogContext) {
		this.shutdownBroadcastAddress =
			process.env.SHUTDOWN_BROADCAST_ADDRESS ||
			DEFAULT_SHUTDOWN_BROADCAST_ADDRESS;
		logger.info(
			this.context,
			`Using shutdownBroadcastAddress: ${this.shutdownBroadcastAddress}`,
			this.shutdownBroadcastAddress,
		);

		this.heartbeatSenderSocket = dgram.createSocket({
			type: 'udp4',
		});
		this.heartbeatClientSocket = dgram.createSocket({
			type: 'udp4',
			reuseAddr: true,
		});
		this.startedAt = startedAt;
		this.handoverMessage = new HandoverMessage(this.startedAt);
		if (context) {
			this.context = context;
		}
	}

	public startBroadcasting() {
		if (this.shuttingDown) {
			logger.warn(
				this.context,
				`PID: ${process.pid}. Not starting ticker because we're shutting down`,
			);
			return;
		}
		if (!this.ticker) {
			this.sendHeartbeat();
			this.ticker = setInterval(this.sendHeartbeat.bind(this), 10 * 1000);
			logger.info(
				this.context,
				`PID: ${
					process.pid
				}. ticker started. timestamp = ${this.startedAt.valueOf()} ( ${
					this.startedAt
				} in local time )`,
			);
		}
	}

	private sendHeartbeat() {
		const message = this.handoverMessage.asBuffer();
		this.heartbeatSenderSocket.send(
			message,
			this.shutdownPort,
			this.shutdownBroadcastAddress,
			(err, bytes) => {
				if (err) {
					logger.error(
						this.context,
						`PID: ${process.pid}. Error when sending packet`,
						err,
					);
				} else {
					logger.info(
						this.context,
						`PID: ${
							process.pid
						}. heartbeat sent. timestamp ${this.startedAt.valueOf()} ( ${
							this.startedAt
						} in local time ) ( ${bytes} bytes))`,
					);
				}
			},
		);
	}

	public startListening(shutdownCallback: () => Promise<void>) {
		this.heartbeatClientSocket.on('error', (err) => {
			logger.error(
				this.context,
				`PID: ${process.pid}. heartbeatClientSocket error:\n${err.stack}`,
			);
			// TODO This error condition could prevent this service for behaving correctly during the handover process.
			// We could exit here but prefer to leave the actual handling to the supervisor
		});

		this.heartbeatClientSocket.on('message', async (msg) => {
			const message = HandoverMessage.decodeMessage(msg);
			// Avoid both committing suicide and processing heartbeats from old instances
			if (BigInt(message.timestamp) > BigInt(this.startedAt.valueOf())) {
				if (this.shuttingDown) {
					return;
				}
				this.shuttingDown = true;
				clearInterval(this.ticker);
				logger.info(
					this.context,
					`PID: ${
						process.pid
					}. Shutting down, theres a new server running with timestamp : ${
						message.timestamp
					} and we have ${this.startedAt.valueOf()}`,
				);

				// Wait for an orderly shutdown
				// Note that this call should take less than `io.balena.update.handover-timeout` because the supervisor will kill the
				// process anyway if that timeout is reached. From the doc:
				// "If the file is not created after a time defined by the io.balena.update.handover-timeout label, the Supervisor kills the old version."
				await shutdownCallback();
				logger.info(
					this.context,
					`PID: ${process.pid}. About to write the shutdown file`,
				);

				const shutMeDownFile = '/tmp/balena/handover-complete'; //  possible paths: /tmp/balena/handover-complete or /tmp/resin/resin-kill-me
				const content = `Shutting down at ${new Date()}`;
				try {
					await fs.writeFile(shutMeDownFile, content);
					logger.info(
						this.context,
						`PID: ${process.pid}. shut-me-down file written at ${shutMeDownFile}`,
					);
				} catch (error) {
					// If there's any error just log it and move on; container will be killed by the supervisor
					logger.warn(
						this.context,
						`PID: ${process.pid}. error when writing shut-me-down file ${shutMeDownFile}`,
						error,
					);
				}
				// We don't exit to avoid docker restarting the process. The container should have a restart policy of `restart: unless-stopped` or `none`
				logger.info(this.context, `PID: ${process.pid}. Waiting for shutdown`);
				this.heartbeatClientSocket.close();
			}
		});

		this.heartbeatClientSocket.on('listening', () => {
			const address = this.heartbeatClientSocket.address();
			logger.info(
				this.context,
				`PID: ${process.pid}. heartbeatClientSocket listening ${address.address}:${address.port}`,
			);
		});

		this.heartbeatClientSocket.bind(this.shutdownPort, () => {
			// The multicastInterface must be a valid string representation of an IP from the socket's family.
			// For IPv4 sockets, this should be the IP configured for the desired physical interface.
			// All packets sent to multicast on the socket will be sent on the interface determined by the most recent successful use of this call.
			if (HANDOVER_NETWORK_MODE === 'host') {
				const nets = networkInterfaces();
				console.log(`nets: ${JSON.stringify(nets, null, 2)}`);
				if (!nets) {
					logger.warn(this.context, `No networks found`);
				} else {
					const balenaNet = nets[NETWORK_INTERFACE];
					if (!balenaNet) {
						logger.warn(
							this.context,
							`Network for interface ${NETWORK_INTERFACE} not found`,
						);
					} else {
						const balenaipv4 = balenaNet.filter((e) => e.family === 'IPv4');
						if (!balenaipv4 || !balenaipv4[0] || !balenaipv4[0].address) {
							logger.warn(
								this.context,
								`Network for interface ${NETWORK_INTERFACE} doesn't have an IPv4 address`,
							);
						} else {
							const balena0Addr = balenaipv4[0].address;
							logger.info(
								this.context,
								`Using MulticastInterface ${balena0Addr}`,
							);
							this.heartbeatClientSocket.setMulticastInterface(balena0Addr);
						}
					}
				}
			}
			this.heartbeatClientSocket.addMembership(this.shutdownBroadcastAddress);
		});
	}
}
