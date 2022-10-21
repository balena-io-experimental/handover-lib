import { HandoverStatusMessage } from '../../lib/handover-status/handover-status-message';

test('should encode and decode a message with multiple addresses', async () => {
	const timestamp = new Date();
	const serviceName = 'api';
	const addresses = ['172.10.0.4', '192.168.0.1'];

	const message = new HandoverStatusMessage(timestamp, serviceName, addresses);
	const buffer = message.asBuffer();
	const decoded = HandoverStatusMessage.decodeMessage(buffer);

	expect(decoded.serviceName).toEqual(serviceName);
	expect(decoded.addresses).toEqual(addresses);
	expect(decoded.timestamp).toEqual(BigInt(timestamp.valueOf()));
});
