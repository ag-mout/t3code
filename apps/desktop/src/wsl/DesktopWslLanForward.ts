import * as NodeNet from "node:net";

import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import { planWslLanForward, wslTailscaleTarget, type WslLanForwardPlan } from "./wslLanForward.ts";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("desktop-wsl-lan-forward");

const relaySocket = (client: NodeNet.Socket, targetHost: string, targetPort: number): void => {
  client.unref();
  const upstream = NodeNet.connect({ host: targetHost, port: targetPort });
  upstream.unref();
  const stop = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", stop);
  upstream.on("error", stop);
  client.on("end", () => upstream.end());
  upstream.on("end", () => client.end());
  client.pipe(upstream);
  upstream.pipe(client);
};

const listenOn = (host: string, plan: WslLanForwardPlan) =>
  Effect.callback<NodeNet.Server, string>((resume) => {
    const server = NodeNet.createServer((socket) =>
      relaySocket(socket, plan.targetHost, plan.targetPort),
    );
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners("error");
      server.on("error", () => undefined);
      server.close();
      resume(Effect.fail(error.message));
    };
    server.once("error", fail);
    server.listen({ host, port: plan.listenPort }, () => {
      if (settled) return;
      settled = true;
      server.off("error", fail);
      server.on("error", () => undefined);
      server.unref();
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      if (!settled) server.close();
    });
  });

const closeServer = (server: NodeNet.Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

/** Binds the first host that is free. Localhost forwarding often owns 127.0.0.1 already. */
export const openWslLanForward = Effect.fn("desktop.wslLanForward.open")(function* (
  plan: WslLanForwardPlan,
) {
  let failure: string | undefined;
  for (const host of plan.listenHosts) {
    const opened = yield* listenOn(host, plan).pipe(
      Effect.asSome,
      Effect.catch((error) => {
        failure = error;
        return Effect.succeed(Option.none<NodeNet.Server>());
      }),
    );
    if (Option.isSome(opened)) {
      yield* logInfo("forwarding the Windows network address into WSL", {
        listenHost: host,
        listenPort: plan.listenPort,
        targetHost: plan.targetHost,
      });
      return opened.value;
    }
  }
  yield* logWarning("could not listen on the Windows network address for WSL", {
    port: plan.listenPort,
    ...(failure === undefined ? {} : { error: failure }),
  });
  return null;
});

interface TailscaleLease {
  readonly servePort: number;
}

export class DesktopWslLanForward extends Context.Service<
  DesktopWslLanForward,
  {
    readonly primaryReady: (config: DesktopBackendStartConfig) => Effect.Effect<void>;
    readonly primaryStopped: Effect.Effect<void>;
  }
>()("@t3tools/desktop/wsl/DesktopWslLanForward") {}

const make = Effect.gen(function* () {
  const exposure = yield* DesktopServerExposure.DesktopServerExposure;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const listenerRef = yield* Ref.make<Option.Option<{ readonly close: Effect.Effect<void> }>>(
    Option.none(),
  );
  const tailscaleRef = yield* Ref.make<Option.Option<TailscaleLease>>(Option.none());

  const closeListener = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(listenerRef, Option.none());
    if (Option.isSome(current)) yield* current.value.close;
  });

  const releaseTailscale = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(tailscaleRef, Option.none());
    if (Option.isNone(current)) return;
    yield* disableTailscaleServe({ servePort: current.value.servePort }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catch((error) =>
        logWarning("could not remove the WSL Tailscale route", { error: error.message }),
      ),
    );
  });

  const primaryStopped = closeListener.pipe(Effect.andThen(releaseTailscale));

  const primaryReady = Effect.fn("desktop.wslLanForward.primaryReady")(function* (
    config: DesktopBackendStartConfig,
  ) {
    const state = yield* exposure.getState;
    const plan = planWslLanForward({ config, exposure: state });
    yield* closeListener;
    if (plan !== null) {
      const server = yield* openWslLanForward(plan);
      if (server !== null) {
        yield* Ref.set(listenerRef, Option.some({ close: closeServer(server) }));
      }
    }

    const target = wslTailscaleTarget(config);
    if (target === null || !state.tailscaleServeEnabled) {
      yield* releaseTailscale;
      return;
    }
    yield* ensureTailscaleServe({
      localHost: target.localHost,
      localPort: target.localPort,
      servePort: state.tailscaleServePort,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.tap(() => Ref.set(tailscaleRef, Option.some({ servePort: state.tailscaleServePort }))),
      Effect.catch((error) =>
        logWarning("could not publish the WSL backend on Tailscale", { error: error.message }),
      ),
    );
  });

  yield* Effect.addFinalizer(() => primaryStopped);

  return DesktopWslLanForward.of({
    primaryReady,
    primaryStopped,
  });
});

export const layer = Layer.effect(DesktopWslLanForward, make);
