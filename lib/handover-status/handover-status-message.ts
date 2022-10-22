const BEGIN = 0;
const V_LENGTH = 1;
const TIMESTAMP_BEGIN = BEGIN + V_LENGTH;
const TIMESTAMP_LENGTH = 8;
const SERVICENAME_BEGIN = TIMESTAMP_BEGIN + TIMESTAMP_LENGTH;
const SERVICENAME_LENGTH = 63;
const ADDRESSES_BEGIN = SERVICENAME_BEGIN + SERVICENAME_LENGTH;
const ADDRESSES_LENGTH = 40;
const STATUS_BEGIN = ADDRESSES_BEGIN + ADDRESSES_LENGTH;
const STATUS_LENGTH = 8;

export class HandoverStatusMessage {
	static TEMPLATE_V2 = [0x02] // 1st byte is the version
		.concat(
			Array(TIMESTAMP_LENGTH).fill(0), // 8 bytes for the timestamp, starting at 1
			Array(SERVICENAME_LENGTH).fill(0), // 63 bytes for the hostname, starting at 9
			Array(ADDRESSES_LENGTH).fill(0), // up to 10 IPv4 addresses, starting at 72
			Array(STATUS_LENGTH).fill(0), // 8 bytes for the status, starting at 112
		);

	timestamp = BigInt(new Date().valueOf());
	serviceName: string;
	addresses: string[];
	status: string;

	// TS-TODO When using bigint instead of string below, which avoids a conversion, we get Error: did not recognize object of type "TSBigIntKeyword"
	// Addresses are received in dot notation: '192.168.0.1'
	constructor(
		timestamp: Date | string,
		serviceName: string,
		addresses: string[],
		status: string,
	) {
		this.timestamp = BigInt(
			typeof timestamp === 'string' ? timestamp : timestamp.valueOf(),
		);
		this.serviceName = serviceName;
		this.addresses = addresses;
		this.status = status;
	}

	private encode(): Buffer {
		const buffer = Buffer.from(HandoverStatusMessage.TEMPLATE_V2);
		buffer.writeBigInt64BE(this.timestamp, 1);

		const encoder = new TextEncoder();
		const serviceNameArray: Uint8Array = encoder.encode(this.serviceName);
		for (let i = 0; i < serviceNameArray.length; i++) {
			const byte = serviceNameArray[i];
			buffer.writeUIntBE(byte, SERVICENAME_BEGIN + i, 1);
		}

		const addressesArray = this.addresses
			.map((address) =>
				address.split('.').map((byteAsString) => parseInt(byteAsString, 10)),
			)
			.flat(1);
		for (let i = 0; i < addressesArray.length; i++) {
			const byte = addressesArray[i];
			buffer.writeUIntBE(byte, ADDRESSES_BEGIN + i, 1);
		}

		const statusArray: Uint8Array = encoder.encode(this.status);
		for (let i = 0; i < statusArray.length; i++) {
			const byte = statusArray[i];
			buffer.writeUIntBE(byte, STATUS_BEGIN + i, 1);
		}
		return buffer;
	}

	public asBuffer(): Buffer {
		return this.encode();
	}

	public static decodeMessage(buffer: Buffer) {
		const version = buffer[0];
		if (version !== HandoverStatusMessage.TEMPLATE_V2[0]) {
			throw new Error(
				`version mismatch on HandoverStatusMessage; expected ${HandoverStatusMessage.TEMPLATE_V2[0]} but received ${version}`,
			);
		}
		const timestamp = buffer.readBigInt64BE(TIMESTAMP_BEGIN);
		const utf8decoder = new TextDecoder();

		let length = 0;
		while (buffer.readUintBE(SERVICENAME_BEGIN + length, 1) !== 0) {
			length++;
		}
		const serviceNameArray = buffer.subarray(
			SERVICENAME_BEGIN,
			SERVICENAME_BEGIN + length,
		);
		const serviceName = utf8decoder.decode(serviceNameArray);

		const addresses: string[] = [];
		const addressesByteArray = buffer.subarray(
			ADDRESSES_BEGIN,
			ADDRESSES_BEGIN + ADDRESSES_LENGTH,
		);
		for (let i = 0; i < addressesByteArray.length; i += 4) {
			const byte0 = addressesByteArray.readUintBE(i, 1);
			const byte1 = addressesByteArray.readUintBE(i + 1, 1);
			const byte2 = addressesByteArray.readUintBE(i + 2, 1);
			const byte3 = addressesByteArray.readUintBE(i + 3, 1);
			if (typeof byte0 !== 'undefined' && byte0 !== 0) {
				const address =
					'' +
					byte0.toString() +
					'.' +
					byte1.toString() +
					'.' +
					byte2.toString() +
					'.' +
					byte3.toString();
				addresses.push(address);
			}
		}

		let statusLength = 0;
		while (buffer.readUintBE(STATUS_BEGIN + statusLength, 1) !== 0) {
			statusLength++;
		}
		const statusArray = buffer.subarray(
			STATUS_BEGIN,
			STATUS_BEGIN + statusLength,
		);
		const status = utf8decoder.decode(statusArray);

		const instance = new HandoverStatusMessage(
			timestamp.toString(10),
			serviceName,
			addresses,
			status,
		);
		return instance;
	}
}
