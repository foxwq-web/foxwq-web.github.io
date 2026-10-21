# foxwq-web.github.io

A web client for the [Fox go server](https://foxwq.com/).

Featuring:

- Matchmaking
- Sound effects
- Score estimation
- SGF export

Try it out: https://foxwq-web.github.io/

## FAQ

#### Is this vibe coded?

Yes, this is a complete slop-fest.
I haven't read a single line of the generated TS and have no interest in doing so.
I wrote this README and all commit messages, the rest is just the AI talking to itself.

#### Where's the backend?

There is no backend.
This project uses a WebSocket-to-TCP proxy hosted on Cloudflare.
Architecturally, this makes it as close as it gets to the original client.

#### Will this break with future Fox updates?

Probably.
Here is the mitigation plan.
The client keeps a (local) log of all network communication.
If something goes wrong, one can download these logs by running `downloadNetworkLog()` from the console.
Then "fox broke (see log.json) fix it make no mistakes".
That's it, that's the plan.
I'm only half joking, see [this commit](https://github.com/foxwq-web/foxwq-web.github.io/commit/27f064b48ebad40eb67d4119476f3170afa1ac45) for an example.

#### Is the score estimator accurate?

This client uses Fox's original score estimation algorithm, so you get the same estimate as your opponent.
The estimator was binary translated to WebAssembly and runs entirely in the browser.

#### Why not minifox/WeiqiHub?

The main differentiating factors are that this client is fully open source and works directly from the browser.

#### Why not OGS?

The playerbase.
At this point OGS has more third-party clients than players LOL.
