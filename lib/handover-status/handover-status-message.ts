export class HandoverStatusMessage {
	static TEMPLATE_V2 = [0x02] // 1st byte is the version
		.concat(
			Array(8).fill(0), // 8 bytes for the timestamp, starting at 1
			Array(63).fill(0), // 63 bytes for the hostname, starting at 9
			Array(40).fill(0), // up to 10 IPv4 addresses, starting at 72
		);

	timestamp = BigInt(new Date().valueOf());
	serviceName: string;
	addresses: string[];
	buffer: Buffer;

	// TS-TODO When using bigint instead of string below, which avoids a conversion, we get Error: did not recognize object of type "TSBigIntKeyword"
	// Addresses are received in dot notation: '192.168.0.1'
	constructor(
		timestamp: Date | string,
		serviceName: string,
		addresses: string[],
	) {
		this.timestamp = BigInt(
			typeof timestamp === 'string' ? timestamp : timestamp.valueOf(),
		);
		this.serviceName = serviceName;
		this.addresses = addresses;

		this.buffer = Buffer.from(HandoverStatusMessage.TEMPLATE_V2);
		this.buffer.writeBigInt64BE(this.timestamp, 1);

		const encoder = new TextEncoder();
		const serviceNameArray: Uint8Array = encoder.encode(serviceName);
		for (let i = 0; i < serviceNameArray.length; i++) {
			const byte = serviceNameArray[i];
			this.buffer.writeUIntBE(byte, 9 + i, 1);
		}

		const addressesArray = addresses
			.map((address) =>
				address.split('.').map((byteAsString) => parseInt(byteAsString, 10)),
			)
			.flat(1);
		for (let i = 0; i < addressesArray.length; i++) {
			const byte = addressesArray[i];
			this.buffer.writeUIntBE(byte, 72 + i, 1);
		}
	}

	public asBuffer(): Buffer {
		return this.buffer;
	}

	public static decodeMessage(buffer: Buffer) {
		const version = buffer[0];
		if (version !== HandoverStatusMessage.TEMPLATE_V2[0]) {
			throw new Error(
				`version mismatch on HandoverStatusMessage; expected ${HandoverStatusMessage.TEMPLATE_V2[0]} but received ${version}`,
			);
		}
		const timestamp = buffer.readBigInt64BE(1);
		const utf8decoder = new TextDecoder();

		let length = 0;
		while (buffer.readUintBE(9 + length, 1) !== 0) {
			length++;
		}
		const serviceNameArray = buffer.subarray(9, 9 + length);
		const serviceName = utf8decoder.decode(serviceNameArray);

		const addresses: string[] = [];
		const addressesByteArray = buffer.subarray(72);
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

		const instance = new HandoverStatusMessage(
			timestamp.toString(10),
			serviceName,
			addresses,
		);
		return instance;
	}
}
