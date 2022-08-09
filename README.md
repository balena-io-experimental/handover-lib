# handover-lib

A HandoverPeer provides a way to coordinate the hand-over between the new and old instances of services that are updated using the "hand-over" update strategy described
at https://www.balena.io/docs/learn/deploy/release-strategy/update-strategies/#hand-over

It implements a simple protocol based on messages broadcasted over UDP. Once its `startBroadcasting` method is called, a `HandoverPeer` will start sending a message 
which contains it startup timestampto a broadcast or multicast address. Converserly, when a `HandoverPeer` receives a message with a timestamp higher than its own one -
signal that there's a younger peer running - it will call the configured `shutdownCallback` function and signal to the Balena Supervisor that it's ready to be killed.

## How to use it

When a service starts, it first will create a `HandoverPeer` instance and calls its `startListening` method with a callback that will shut down the service.
When the service is ready to accept connections, it will call the `startBroadcasting` method, thus starting to broadcast a packet that contains its
startup timestamp and letting other peers ( there should be only one active in normal circumstances ) that they should shut down.

## Using the hand-over update strategy

The [hand-over update strategy](https://www.balena.io/docs/learn/deploy/release-strategy/update-strategies/#hand-over), provides us with an update mechanism in which
there is an period during which both instances, the old and the new one, will be running concurrently. This is in contrast to the default [download-then-kill](https://www.balena.io/docs/learn/deploy/release-strategy/update-strategies/#download-then-kill) strategy or the [kill-then-download](https://www.balena.io/docs/learn/deploy/release-strategy/update-strategies/#kill-then-download) which only keep one instance running at a time.

The hand-over strategy allows us to keep the old instance running while the new one starts up. During this period both instances will be running and possibly handling requests,
broadly speaking. For example, both could consume messages from a queue. The supervisor will kill the old instance when either the instance signals it's ready to be killed by creating a file ( `/tmp/balena/handover-complete` ) , or when the specified timeout passes ( `io.balena.update.handover-timeout` ).

The hand-over strategy allows us to cover the following use cases:

- no downtime even with slow server startup: the supervisor will start the new instance and keep the old one running while the new one starts up. The new instance will `startBroadcasting` once it's ready to handle requests. The old instance will shutdown itself once it receives the "new instance" message. For this use case, configure the `io.balena.update.handover-timeout` to be higher than the expected start up time to avoid a period when there's no instance ready to handle requests.
- clean shutdown: once the old instance receives the "new instance" message, the `shutdownCallback` will be called from the `HandoverPeer`. In this function the instance can perform a clean shutdown releasing the resources it acquired, closing connections, etc. Again, the `io.balena.update.handover-timeout` should give enough time to perform a clean shutdown.

Note that the "clean shutdown" should be a "nice to have" requirement. The application should be prepared to be shutdown anytime, with no previous notification.

To recap: the `io.balena.update.handover-timeout` should be configured so that it provides enough time for the new service to be ready to handle connections to avoid downtime, and for the old service to perform its shutdown.


### Jellyfish

In Jellyfish,
each service runs a set of node Worker processes. When a new service starts, it will spawn a set of Workers that will run the initialization code.
There's a period of time during which the Workers from the old service will consume jobs from the queues that are inserted by the new service, and viceversa.



## hand-over strategy and DNS

The handover of the DNS name of the instance will be performed only when the supervisor kills the old container. This means that the new instance gets a new IP address, but until the 
old container is killed the DNS name assigned to the container will refer to the IP address of the old instance.

This behavior produces a conflict between the "now downtime" and the "clean shutdown" goals. If the container handles requests by listening to a network port, then the new instance will start receiving requests only when the old container is killed and the DNS name is updated. This means that while the old conatainer is performing a clean shutdown, there will be downtime because the new container is ready to handle requests but no other clients now about its existence, and the old container is shutting down. So the conflict is between a) doing an orderly shutdown that may produce some downtime if during this process a request is received and b) shutting the container abruptly so that the DNS name switches to the new one making the new instance handle the incoming requests.


## HandoverPeer on `bridge` and `host` networks


Networking - On a fleet with several devices running on the same LAN:

By default (HANDOVER_NETWORK_MODE=bridge) a multicast address is used; the service listens on all interfaces for updates.
In a docker bridge-mode network, the old and new instances will be the only ones using this address.

If the fleet uses a host-mode network, if there
are several devices running the application in the same LAN, like in a fleet, then a multicast address would be be shared by all of the container instances and 
this would cause only one to be selected
as the "new one", meaning that in one node both instances will shutdown and recreated, creating an infinite loop.
To avoid this, if using an application which has
host-mode network, you can specify the HANDOVER_NETWORK_MODE=host env var. This will cause the library to use the multicast address only on the
supervisor0 interface, which is a local bridge network.

