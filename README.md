# handover-lib

A HandoverPeer provides a way to coordinate the handover between the new and old instances of services that are updated using the handover strategy described
at https://www.balena.io/docs/learn/deploy/release-strategy/update-strategies/#hand-over

It implements a simple protocol based on messages broadcasted over UDP. Each peer broadcast a message wich contains it startup timestamp. Whenever a server receives
a message with a higher timestamp than its own, it realizes that there's a younger instance running and shuts itself down in an orderly fashion.

When a service starts, it first will create a `HandoverPeer` and calls its `startListening` method with a callback that will shut down the service.
When it's ready to accept connections, it will call the `startBroadcasting` method, thus starting to broadcast a packet that contains its
startup timestamp and letting other peers ( there should be one active in normal circumstances ) that they should shut down.

Note that there is an overlap in which both services will be running concurrently, thus the application needs to handle this situation correctly. In Jellyfish,
each service runs a set of node Worker processes. When a new service starts, it will spawn another set of Workers that will run the initialization code.
There's a period of time during which the Workers from the old service will consume jobs from the queues that are inserted by the new service. Thus it is
critical to perform the shutdown in an orderly fashion to avoid lost data.

Also note that the handover strategy will kill the old service after the configured `io.balena.update.handover-timeout` so it's important to configura that value
so that an orderly shutdown can be performed and the new service is ready to process actions.

Networking - On a fleet with several devices running on the same LAN:

By default (HANDOVER_NETWORK_MODE=bridge) a multicast address is used; the service listens on all interfaces for updates.
In a docker bridge-mode network, the old and new instances will be the only ones using this address.

If the fleet uses a host-mode network, if there
are several devices running the application in the same LAN, like in a fleet, then a multicast address would be be shared by all of the container instances and 
this would cause only one to be selected
as the "new one", meaning that in one node both instances will shutdown and recreated, creating an infinite loop.
To avoid this, if using an application which has
host-mode network, you can specify the HANDOVER_NETWORK_MODE=host env var. This will cause the library to use the multicast address only on the
supervisor0 interface, which is local bridge. 

