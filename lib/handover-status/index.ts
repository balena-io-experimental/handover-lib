import dgram from 'node:dgram';
import { getLogger, LogContext } from '@balena/jellyfish-logger';
import { HandoverStatusMessage } from './handover-status-message';
import { networkInterfaces } from 'os';
const logger = getLogger(__filename);

/**
 * Publish and receive handover status notifications
 */

// Following https://www.rfc-editor.org/rfc/rfc2365.html, we use "The IPv4 Organization Local Scope -- 239.192.0.0/14" [ 239.192.0.0, 239.195.255.255 ]
// 239.192.0.0/14 is defined to be the IPv4 Organization Local Scope, and is the space from which an organization should allocate sub-ranges when defining scopes for private use.

const DEFAULT_BROADCAST_ADDRESS = '239.192.16.16';

/**
 * The default network interface to try
 */
const NETWORK_INTERFACE = process.env.NETWORK_INTERFACE || 'supervisor0';

const HANDOVER_NETWORK_MODE = process.env.HANDOVER_NETWORK_MODE || 'bridge';

export class HandoverStatus {
	networkPort: number = parseInt(
		process.env.HANDOVER_STATUS_PORT || '1537',
		10,
	);
	statusBroadcastAddress: string;
	downTicker?: NodeJS.Timer;
	upTicker?: NodeJS.Timer;
	heartbeatSenderSocket: dgram.Socket;
	heartbeatClientSocket: dgram.Socket;
	startedAt: Date;
	serviceUpMessage: HandoverStatusMessage;
	serviceDownMessage: HandoverStatusMessage;
	context: LogContext = {
		id: `PID${process.pid}-${'[' + Math.round(Math.random() * 1000) + ']'}-`,
	};

	constructor(
		startedAt: Date,
		serviceName: string,
		addresses: string[],
		context?: LogContext,
	) {
		this.statusBroadcastAddress =
			process.env.HANDOVER_STATUS_BROADCAST_ADDRESS ||
			DEFAULT_BROADCAST_ADDRESS;
		logger.info(
			this.context,
			`Using statusBroadcastAddress: ${this.statusBroadcastAddress}`,
			this.statusBroadcastAddress,
		);

		this.heartbeatSenderSocket = dgram.createSocket({
			type: 'udp4',
		});
		this.heartbeatClientSocket = dgram.createSocket({
			type: 'udp4',
			reuseAddr: true,
		});
		this.startedAt = startedAt;
		this.serviceUpMessage = new HandoverStatusMessage(
			this.startedAt,
			serviceName,
			addresses,
			'UP',
		);
		this.serviceDownMessage = new HandoverStatusMessage(
			this.startedAt,
			serviceName,
			addresses,
			'DOWN',
		);

		if (context) {
			this.context = context;
		}
	}

	public startBroadcastingServiceUp() {
		if (!this.upTicker) {
			this.sendServiceUp();
			this.upTicker = setInterval(this.sendServiceUp.bind(this), 10 * 1000);
			logger.info(
				this.context,
				`PID: ${
					process.pid
				}. upTicker started. timestamp = ${this.startedAt.valueOf()} ( ${
					this.startedAt
				} in local time )`,
			);
		}
	}

	public startBroadcastingServiceDown() {
		this.sendServiceDown();
		if (this.downTicker) {
			clearInterval(this.downTicker);
		}
		this.downTicker = setInterval(this.sendServiceDown.bind(this), 100);
		logger.info(
			this.context,
			`PID: ${
				process.pid
			}. downTicker started. timestamp = ${this.startedAt.valueOf()} ( ${
				this.startedAt
			} in local time )`,
		);
	}

	private sendServiceUp() {
		const message = this.serviceUpMessage.asBuffer();
		this.sendHeartbeat(message, 'UP');
	}

	private sendServiceDown() {
		const message = this.serviceDownMessage.asBuffer();
		this.sendHeartbeat(message, 'DOWN');
	}

	private sendHeartbeat(message: Buffer, kind: string) {
		this.heartbeatSenderSocket.send(
			message,
			this.networkPort,
			this.statusBroadcastAddress,
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
						}. ${kind} heartbeat sent. timestamp ${this.startedAt.valueOf()} ( ${
							this.startedAt
						} in local time ) ( ${bytes} bytes))`,
					);
				}
			},
		);
	}

	public startListening(
		heartbeatMessageCallback: (message: HandoverStatusMessage) => Promise<void>,
	) {
		this.heartbeatClientSocket.on('error', (err) => {
			logger.error(
				this.context,
				`PID: ${process.pid}. heartbeatClientSocket error:\n${err.stack}`,
			);
			// TODO This error condition could prevent this service for behaving correctly during the handover process.
			// We could exit here but prefer to leave the actual handling to the supervisor
		});

		this.heartbeatClientSocket.on('message', async (msg) => {
			const message = HandoverStatusMessage.decodeMessage(msg);
			await heartbeatMessageCallback(message);
		});

		this.heartbeatClientSocket.on('listening', () => {
			const address = this.heartbeatClientSocket.address();
			logger.info(
				this.context,
				`PID: ${process.pid}. heartbeatClientSocket listening ${address.address}:${address.port}`,
			);
		});

		this.heartbeatClientSocket.bind(this.networkPort, () => {
			// The multicastInterface must be a valid string representation of an IP from the socket's family.
			// For IPv4 sockets, this should be the IP configured for the desired physical interface.
			// All packets sent to multicast on the socket will be sent on the interface determined by the most recent successful use of this call.
			if (HANDOVER_NETWORK_MODE === 'host') {
				const nets = networkInterfaces();
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
			this.heartbeatClientSocket.addMembership(this.statusBroadcastAddress);
		});
	}

	public close() {
		if (this.downTicker) {
			clearInterval(this.downTicker);
		}
		if (this.upTicker) {
			clearInterval(this.upTicker);
		}
		if (this.heartbeatSenderSocket) {
			this.heartbeatSenderSocket.close();
		}
		if (this.heartbeatClientSocket) {
			this.heartbeatClientSocket.close();
		}
	}
}
