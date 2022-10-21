import { HandoverStatus } from '../../lib';
import { HandoverStatusMessage } from '../../lib/handover-status/handover-status-message';

test('should work', (done) => {
	const timestamp = new Date();
	const serviceName = 'api';
	const addresses = ['172.10.0.4', '192.168.0.1'];
	const handover = new HandoverStatus(timestamp, serviceName, addresses);
	handover.startBroadcastingServiceUp();
	handover.startBroadcastingServiceDown();
	let upReceived = false;
	let downReceived = false;
	handover.startListening(async (message: HandoverStatusMessage) => {
		console.log(message);
		upReceived = upReceived || message.addresses.length > 0;
		downReceived = downReceived || message.addresses.length === 0;
		if (upReceived && downReceived) {
			handover.close();
			done();
		}
	});
});
