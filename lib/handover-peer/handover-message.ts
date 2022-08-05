export class HandoverMessage {
	static TEMPLATE = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]; // 1st byte is the version, 8 bytes for the timestamp
	timestamp = BigInt(new Date().valueOf());
	buffer: Buffer;

	// TS-TODO When using bigint instead of string below, which avoids a conversion, we get Error: did not recognize object of type "TSBigIntKeyword"
	constructor(timestamp: Date | string) {
		this.timestamp = BigInt(
			typeof timestamp === 'string' ? timestamp : timestamp.valueOf(),
		);
		this.buffer = Buffer.from(HandoverMessage.TEMPLATE);
		this.buffer.writeBigInt64BE(this.timestamp, 1);
	}

	public asBuffer(): Buffer {
		return this.buffer;
	}

	public static decodeMessage(buffer: Buffer) {
		const version = buffer[0];
		if (version !== HandoverMessage.TEMPLATE[0]) {
			throw new Error(
				`version mismatch on HandoverMessage; expected ${HandoverMessage.TEMPLATE[0]} but received ${version}`,
			);
		}
		const timestamp = buffer.readBigInt64BE(1);
		const instance = new HandoverMessage(timestamp.toString(10));
		return instance;
	}
}
